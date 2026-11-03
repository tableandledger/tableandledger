/**
 * Table & Ledger -- Sign Concierge intake handler
 *
 * Cloudflare Pages Function that receives multipart POSTs from /sign/.
 * Deployed at /api/sign. It checks the honeypot, verifies the Turnstile
 * token, validates the request and the PDF, builds a job manifest, and
 * hands both to storeAndNotify().
 *
 * storeAndNotify() is the only code that touches storage or email. Today
 * (Option A) it emails the PDF and the manifest to the back room through
 * Resend. A later swap to R2 changes only that function.
 *
 * Env vars (set in Cloudflare Pages -> Settings -> Environment variables):
 *   RESEND_API_KEY    -- Bearer token from resend.com (shared with /api/contact)
 *   TURNSTILE_SECRET  -- Turnstile widget secret key
 *   SIGN_NOTIFY_TO    -- optional, overrides the notify address
 *
 * Logging rule: console output carries the job id only. Never log document
 * contents, names, or email addresses.
 */

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 50;
const MAX_SIGNERS = 5;
const MAX_FIELD = 200;
const MAX_NOTES = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function onRequestPost(context) {
    const { request, env } = context;

    // --- a. Parse body ---
    let form;
    try {
        form = await request.formData();
    } catch (err) {
        return json({ error: 'Could not read the form submission.' }, 400);
    }

    const field = (name) => {
        const v = form.get(name);
        return typeof v === 'string' ? v.trim() : '';
    };

    // --- b. Honeypot (silent drop) ---
    if (field('company_website') !== '') {
        return json({ ok: true });
    }

    // --- c. Turnstile ---
    if (!env.TURNSTILE_SECRET) {
        console.error('sign: TURNSTILE_SECRET is not set');
        return json({ error: 'Spam check is not configured.' }, 500);
    }
    const token = field('cf-turnstile-response');
    const human = await verifyTurnstile(token, env.TURNSTILE_SECRET, request.headers.get('CF-Connecting-IP'));
    if (!human) {
        return json({ error: 'Spam check failed. Reload the page and try again.' }, 400);
    }

    // --- d. Validate ---
    const name = field('name');
    const business = field('business');
    const email = field('email');
    const docName = field('doc_name');
    const dueDate = field('due_date');
    const notes = field('notes');

    if (!name || !business || !email) {
        return json({ error: 'Your name, business name, and email are all required.' }, 400);
    }
    if (!EMAIL_RE.test(email)) {
        return json({ error: 'Your email address does not look right.' }, 400);
    }
    if (name.length > MAX_FIELD || business.length > MAX_FIELD || email.length > MAX_FIELD) {
        return json({ error: 'One of your contact fields is unreasonably long.' }, 400);
    }
    if (!docName) {
        return json({ error: 'Give the document a name so we can track it.' }, 400);
    }
    if (docName.length > MAX_FIELD) {
        return json({ error: 'The document name is too long. Keep it under 200 characters.' }, 400);
    }

    const file = form.get('pdf');
    if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
        return json({ error: 'Attach the PDF you want signed.' }, 400);
    }
    if (!file.size) {
        return json({ error: 'That file is empty.' }, 400);
    }
    if (file.size > MAX_FILE_BYTES) {
        return json({ error: 'That PDF is over 20 MB. Compress it or split it and try again.' }, 400);
    }
    const pdfBytes = new Uint8Array(await file.arrayBuffer());
    if (!isPdf(pdfBytes)) {
        return json({ error: 'That file is not a PDF. Export or print it to PDF and try again.' }, 400);
    }

    const signerNames = form.getAll('signer_name');
    const signerEmails = form.getAll('signer_email');
    const signerOrders = form.getAll('signer_order');
    const signerCount = Math.max(signerNames.length, signerEmails.length, signerOrders.length);
    if (signerCount < 1) {
        return json({ error: 'Add at least one signer.' }, 400);
    }
    if (signerCount > MAX_SIGNERS) {
        return json({ error: 'Five signers is the limit for now. Email us if you need more.' }, 400);
    }
    const signers = [];
    for (let i = 0; i < signerCount; i++) {
        const sName = String(signerNames[i] ?? '').trim();
        const sEmail = String(signerEmails[i] ?? '').trim();
        const sOrder = String(signerOrders[i] ?? 'all').trim();
        const label = `Signer ${i + 1}`;
        if (!sName || !sEmail) {
            return json({ error: `${label} needs a name and an email.` }, 400);
        }
        if (sName.length > MAX_FIELD || sEmail.length > MAX_FIELD) {
            return json({ error: `${label} has a field that is unreasonably long.` }, 400);
        }
        if (!EMAIL_RE.test(sEmail)) {
            return json({ error: `${label}'s email address does not look right.` }, 400);
        }
        if (sOrder !== 'all' && !/^[1-5]$/.test(sOrder)) {
            return json({ error: `${label}'s signing order is not valid.` }, 400);
        }
        signers.push({ name: sName, email: sEmail, order: sOrder === 'all' ? 'all' : Number(sOrder) });
    }

    if (dueDate && !isIsoDate(dueDate)) {
        return json({ error: 'The due date does not look right. Use the date picker.' }, 400);
    }
    if (notes.length > MAX_NOTES) {
        return json({ error: 'Notes are too long. Keep them under 5,000 characters.' }, 400);
    }
    if (!form.get('no_medical')) {
        return json({ error: 'Confirm the document contains no medical or patient information.' }, 400);
    }

    const pages = countPages(pdfBytes);
    if (pages > MAX_PAGES) {
        return json({ error: `That PDF looks like ${pages} pages. The limit is ${MAX_PAGES}. Split it and send the parts separately.` }, 400);
    }

    // --- e. Job id ---
    const jobId = crypto.randomUUID();

    // --- f. Manifest ---
    const manifest = {
        job_id: jobId,
        received_at: new Date().toISOString(),
        requester: { name, business, email },
        doc_name: docName,
        signers,
        due_date: dueDate || null,
        notes: notes || null,
        page_count: pages > 0 ? pages : null,
        file_size: file.size,
        file_name: sanitizeFileName(file.name),
        source: 'tableandledger.com/sign',
    };

    // --- g. Store and notify ---
    const result = await storeAndNotify(manifest, pdfBytes, env);
    if (!result.ok) {
        console.error(`sign: job ${jobId} notify failed ${result.status}`);
        return json({ error: result.error }, result.httpStatus || 502);
    }

    // --- h. Done ---
    console.log(`sign: job ${jobId} received`);
    return json({ ok: true, job_id: jobId });
}

/**
 * The only function that touches storage or email.
 * Option A: one Resend email carrying the PDF and the manifest as attachments.
 * Returns { ok: true } or { ok: false, status, error, httpStatus }.
 */
async function storeAndNotify(manifest, pdfBytes, env) {
    if (!env.RESEND_API_KEY) {
        return { ok: false, status: 'no-key', error: 'Mail is not configured on the server.', httpStatus: 500 };
    }

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
    const orderLabel = (o) => (o === 'all' ? 'all at once' : `order ${o}`);

    const subject = `Sign Concierge: ${manifest.doc_name} / ${manifest.requester.business}`;

    const textBody = [
        `Job: ${manifest.job_id}`,
        `Received: ${manifest.received_at}`,
        '',
        `Requester: ${manifest.requester.name} <${manifest.requester.email}>`,
        `Business: ${manifest.requester.business}`,
        '',
        `Document: ${manifest.doc_name}`,
        `File: ${manifest.file_name} (${manifest.file_size} bytes)`,
        `Pages: ${manifest.page_count === null ? 'unknown, check by hand' : manifest.page_count}`,
        `Due: ${manifest.due_date || 'none given'}`,
        '',
        'Signers:',
        ...manifest.signers.map((s, i) => `  ${i + 1}. ${s.name} <${s.email}>, ${orderLabel(s.order)}`),
        '',
        'Notes:',
        manifest.notes || '(none)',
        '',
        '--',
        'Attachments: source.pdf (the upload), job.json (this manifest).',
        'Sent from the Sign Concierge form on tableandledger.com',
    ].join('\n');

    const row = (label, value) =>
        `<p style="margin: 0 0 0.5rem;"><strong>${esc(label)}:</strong> ${esc(value)}</p>`;

    const htmlBody = `
        <div style="font-family: Georgia, serif; max-width: 640px; color: #1a1a18; line-height: 1.6;">
            <p style="margin: 0 0 1.25rem; font-family: 'Courier New', monospace; font-size: 0.75rem; color: #8a8780; text-transform: uppercase; letter-spacing: 0.12em;">Sign Concierge / tableandledger.com</p>
            <p style="margin: 0 0 1rem; font-family: 'Courier New', monospace; font-size: 0.85rem;">Job ${esc(manifest.job_id)}</p>
            ${row('Received', manifest.received_at)}
            ${row('Requester', `${manifest.requester.name} <${manifest.requester.email}>`)}
            ${row('Business', manifest.requester.business)}
            <hr style="border: none; border-top: 1px solid #d4d0c8; margin: 1.5rem 0;">
            ${row('Document', manifest.doc_name)}
            ${row('File', `${manifest.file_name} (${manifest.file_size} bytes)`)}
            ${row('Pages', manifest.page_count === null ? 'unknown, check by hand' : manifest.page_count)}
            ${row('Due', manifest.due_date || 'none given')}
            <p style="margin: 1rem 0 0.5rem;"><strong>Signers:</strong></p>
            <ol style="margin: 0 0 1rem; padding-left: 1.25rem;">
                ${manifest.signers.map((s) => `<li>${esc(s.name)} &lt;${esc(s.email)}&gt;, ${esc(orderLabel(s.order))}</li>`).join('')}
            </ol>
            <hr style="border: none; border-top: 1px solid #d4d0c8; margin: 1.5rem 0;">
            <p style="margin: 0 0 0.5rem;"><strong>Notes:</strong></p>
            <div style="white-space: pre-wrap;">${esc(manifest.notes || '(none)')}</div>
        </div>
    `;

    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

    let res;
    try {
        res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: 'Table & Ledger <contact@tableandledger.com>',
                to: [env.SIGN_NOTIFY_TO || 'info@tableandledger.com'],
                reply_to: manifest.requester.email,
                subject,
                text: textBody,
                html: htmlBody,
                attachments: [
                    { filename: 'source.pdf', content: bytesToBase64(pdfBytes) },
                    { filename: 'job.json', content: bytesToBase64(manifestBytes) },
                ],
            }),
        });
    } catch (err) {
        return { ok: false, status: 'fetch-error', error: 'Could not reach the mail service. Try again in a minute.', httpStatus: 502 };
    }

    if (!res.ok) {
        // Drain the body but do not log it: Resend error bodies can echo addresses.
        await res.text().catch(() => '');
        return { ok: false, status: res.status, error: 'The mail service rejected the upload. Try again, or email info@tableandledger.com.', httpStatus: 502 };
    }

    return { ok: true };
}

// --- Helpers ---

async function verifyTurnstile(token, secret, ip) {
    if (!token || token.length > 2048) return false;
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    try {
        const res = await fetch(SITEVERIFY_URL, { method: 'POST', body });
        if (!res.ok) return false;
        const outcome = await res.json();
        return outcome.success === true;
    } catch (err) {
        return false;
    }
}

function isPdf(bytes) {
    // %PDF-
    return bytes.length >= 5 &&
        bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
        bytes[3] === 0x46 && bytes[4] === 0x2d;
}

function isIsoDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Best effort. Pages inside compressed object streams are invisible to this,
// so 0 means unknown and the back room re-checks.
function countPages(bytes) {
    const matches = bytesToLatin1(bytes).match(/\/Type\s*\/Page(?![s\w])/g);
    return matches ? matches.length : 0;
}

function bytesToLatin1(bytes) {
    // Native decoder first. Per the Encoding spec "latin1" is windows-1252,
    // which remaps a few bytes above 0x7F. The page regex is pure ASCII, so
    // that does not change the count.
    try {
        return new TextDecoder('latin1').decode(bytes);
    } catch (err) {
        // Runtime lacks the label: fall through to the manual path.
    }
    // Chunked so a 20 MB file never spreads into one giant argument list.
    const CHUNK = 0x8000;
    const parts = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
        parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    return parts.join('');
}

function bytesToBase64(bytes) {
    // Native encoder where the runtime has it.
    if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
    // Fallback: encode in chunks whose length is a multiple of 3, so each
    // chunk's base64 joins cleanly with no padding in the middle.
    const CHUNK = 0x2000 * 3;
    const parts = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
        parts.push(btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))));
    }
    return parts.join('');
}

function sanitizeFileName(raw) {
    const base = String(raw || '').split(/[\\/]/).pop();
    const clean = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
    return clean || 'upload.pdf';
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
        },
    });
}
