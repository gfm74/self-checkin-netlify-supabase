const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const MAX_BASE64_BYTES = 8 * 1024 * 1024;
const DEFAULT_SIGNED_URL_SECONDS = 60 * 60 * 24 * 7;

function json(statusCode, payload) {
  return new Response(JSON.stringify(payload), {
    status: statusCode,
    headers: JSON_HEADERS
  });
}

function sanitizeFileName(value) {
  return String(value || "selfie.jpg")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

async function uploadToSupabase({ supabaseUrl, serviceRoleKey, bucket, path, mimeType, bytes }) {
  const uploadUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${path}`;
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": mimeType,
      "x-upsert": "false"
    },
    body: bytes
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`storage-upload-failed:${response.status}:${text}`);
  }
}

async function insertCheckinRow({ supabaseUrl, serviceRoleKey, table, row }) {
  const insertUrl = `${supabaseUrl}/rest/v1/${table}`;
  const response = await fetch(insertUrl, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation,resolution=merge-duplicates"
    },
    body: JSON.stringify(row)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`db-insert-failed:${response.status}:${text}`);
  }

  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function findCheckinBySubmissionId({ supabaseUrl, serviceRoleKey, table, submissionId }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  url.searchParams.set("submission_id", `eq.${submissionId}`);
  url.searchParams.set("select", "id,submission_id,status,file_path,created_at");
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`db-select-failed:${response.status}:${text}`);
  }

  const rows = await response.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function updateCheckinRow({ supabaseUrl, serviceRoleKey, table, submissionId, patch }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  url.searchParams.set("submission_id", `eq.${submissionId}`);

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(patch)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`db-update-failed:${response.status}:${text}`);
  }

  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function createSignedFileUrl({ supabaseUrl, serviceRoleKey, bucket, path, expiresIn }) {
  const encodedPath = String(path)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

  const response = await fetch(`${supabaseUrl}/storage/v1/object/sign/${bucket}/${encodedPath}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      expiresIn
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`signed-url-failed:${response.status}:${text}`);
  }

  const data = await response.json();
  const relativeUrl = data.signedUrl || data.signedURL || "";

  if (!relativeUrl) {
    throw new Error("signed-url-missing");
  }

  return relativeUrl.startsWith("http")
    ? relativeUrl
    : `${supabaseUrl}/storage/v1${relativeUrl}`;
}

async function sendResendEmail({ apiKey, from, to, subject, html }) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`resend-failed:${response.status}:${text}`);
  }

  return response.json();
}

async function sendTelegramMessage({ botToken, chatId, text }) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false
    })
  });

  if (!response.ok) {
    const textBody = await response.text();
    throw new Error(`telegram-failed:${response.status}:${textBody}`);
  }

  return response.json();
}

function buildEmailHtml({ language, filePath, signedUrl, submissionId, createdAt }) {
  const lang = String(language || "en").toLowerCase();
  const labels = {
    it: {
      title: "Nuovo selfie check-in",
      intro: "E' arrivato un nuovo selfie di check-in.",
      photo: "Apri la foto",
      submissionId: "Submission ID",
      filePath: "Percorso file",
      createdAt: "Creato il"
    },
    en: {
      title: "New check-in selfie",
      intro: "A new check-in selfie has been received.",
      photo: "Open photo",
      submissionId: "Submission ID",
      filePath: "File path",
      createdAt: "Created at"
    }
  };

  const t = labels[lang] || labels.en;
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#1f2121;">
      <h2 style="margin:0 0 12px;">${t.title}</h2>
      <p style="margin:0 0 16px;">${t.intro}</p>
      <p style="margin:0 0 16px;">
        <a href="${signedUrl}" style="background:#208091;color:#ffffff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block;">
          ${t.photo}
        </a>
      </p>
      <p style="margin:0 0 8px;"><strong>${t.submissionId}:</strong> ${submissionId}</p>
      <p style="margin:0 0 8px;"><strong>${t.filePath}:</strong> ${filePath}</p>
      <p style="margin:0;"><strong>${t.createdAt}:</strong> ${createdAt}</p>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildTelegramMessage({ language, filePath, signedUrl, submissionId, createdAt }) {
  const lang = String(language || "en").toLowerCase();
  const labels = {
    it: {
      title: "Nuovo selfie check-in",
      photo: "Apri foto",
      submissionId: "Submission ID",
      filePath: "File",
      createdAt: "Creato"
    },
    en: {
      title: "New check-in selfie",
      photo: "Open photo",
      submissionId: "Submission ID",
      filePath: "File",
      createdAt: "Created"
    }
  };

  const t = labels[lang] || labels.en;
  return [
    `<b>${escapeHtml(t.title)}</b>`,
    `<a href="${escapeHtml(signedUrl)}">${escapeHtml(t.photo)}</a>`,
    `${escapeHtml(t.submissionId)}: <code>${escapeHtml(submissionId)}</code>`,
    `${escapeHtml(t.filePath)}: <code>${escapeHtml(filePath)}</code>`,
    `${escapeHtml(t.createdAt)}: <code>${escapeHtml(createdAt)}</code>`
  ].join("\n");
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...JSON_HEADERS,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      }
    });
  }

  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed", code: "method_not_allowed" });
  }

  try {
    const supabaseUrl = getRequiredEnv("SUPABASE_URL");
    const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || "selfies";
    const table = process.env.SUPABASE_CHECKINS_TABLE || "checkin_selfies";
    const resendApiKey = process.env.RESEND_API_KEY || "";
    const notifyTo = process.env.SELFIE_NOTIFY_TO || "";
    const resendFrom = process.env.RESEND_FROM_EMAIL || "";
    const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || "";
    const telegramChatId = process.env.TELEGRAM_CHAT_ID || "";
    const signedUrlSeconds = Number(process.env.SELFIE_LINK_EXPIRES_IN || DEFAULT_SIGNED_URL_SECONDS);

    const body = await request.json();
    const submissionId = String(body.submissionId || "").trim();
    const language = String(body.language || "en").trim().slice(0, 5);
    const originalName = sanitizeFileName(body.originalName || "selfie.jpg");
    const mimeType = String(body.mimeType || "");
    const imageBase64 = String(body.imageBase64 || "");
    const clientTimestamp = body.clientTimestamp ? String(body.clientTimestamp) : null;

    if (!submissionId || !mimeType || !imageBase64) {
      return json(400, { error: "Missing payload fields", code: "invalid_payload" });
    }

    if (mimeType !== "image/jpeg") {
      return json(400, { error: "Only JPEG uploads are supported", code: "invalid_mime_type" });
    }

    const estimatedBytes = Math.ceil((imageBase64.length * 3) / 4);
    if (estimatedBytes > MAX_BASE64_BYTES) {
      return json(413, { error: "Image too large", code: "payload_too_large" });
    }

    const now = new Date();
    const y = String(now.getUTCFullYear());
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const filePath = `${y}/${m}/${submissionId}-${originalName || "selfie.jpg"}`;
    const bytes = Buffer.from(imageBase64, "base64");

    const existingRow = await findCheckinBySubmissionId({
      supabaseUrl,
      serviceRoleKey,
      table,
      submissionId
    });

    if (existingRow) {
      return json(409, { error: "Duplicate submission", code: "duplicate_submission" });
    }

    try {
      await uploadToSupabase({
        supabaseUrl,
        serviceRoleKey,
        bucket,
        path: filePath,
        mimeType,
        bytes
      });
    } catch (error) {
      throw error;
    }

    const dbRow = await insertCheckinRow({
      supabaseUrl,
      serviceRoleKey,
      table,
      row: {
        submission_id: submissionId,
        language,
        file_path: filePath,
        file_name: originalName,
        mime_type: mimeType,
        size_bytes: bytes.byteLength,
        client_timestamp: clientTimestamp,
        source: "netlify-self-checkin",
        status: "stored"
      }
    }).catch(async (error) => {
      if (String(error.message).includes("duplicate key value")) {
        await updateCheckinRow({
          supabaseUrl,
          serviceRoleKey,
          table,
          submissionId,
          patch: {
            language,
            file_path: filePath,
            file_name: originalName,
            mime_type: mimeType,
            size_bytes: bytes.byteLength,
            client_timestamp: clientTimestamp,
            source: "netlify-self-checkin",
            status: "stored"
          }
        }).catch(() => null);
        return findCheckinBySubmissionId({
          supabaseUrl,
          serviceRoleKey,
          table,
          submissionId
        });
      }
      throw error;
    });

    let notification = { enabled: false, sent: false, channel: null, error: null };
    const shouldNotify = (
      (resendApiKey && notifyTo && resendFrom) ||
      (telegramBotToken && telegramChatId)
    );

    if (shouldNotify) {
      try {
        const signedUrl = await createSignedFileUrl({
          supabaseUrl,
          serviceRoleKey,
          bucket,
          path: filePath,
          expiresIn: signedUrlSeconds
        });

        const createdAt = new Date().toISOString();

        if (telegramBotToken && telegramChatId) {
          await sendTelegramMessage({
            botToken: telegramBotToken,
            chatId: telegramChatId,
            text: buildTelegramMessage({
              language,
              filePath,
              signedUrl,
              submissionId,
              createdAt
            })
          });

          notification = { enabled: true, sent: true, channel: "telegram", error: null };
        } else if (resendApiKey && notifyTo && resendFrom) {
          await sendResendEmail({
            apiKey: resendApiKey,
            from: resendFrom,
            to: notifyTo,
            subject: `Nuovo selfie check-in (${language.toUpperCase()})`,
            html: buildEmailHtml({
              language,
              filePath,
              signedUrl,
              submissionId,
              createdAt
            })
          });

          notification = { enabled: true, sent: true, channel: "email", error: null };
        }
      } catch (error) {
        console.error("notification setup or delivery error", error);
        notification = {
          enabled: true,
          sent: false,
          channel: telegramBotToken && telegramChatId ? "telegram" : "email",
          error: "notification_failed"
        };
      }
    }

    return json(200, {
      ok: true,
      status: "stored",
      submissionId,
      filePath,
      rowId: dbRow && dbRow.id ? dbRow.id : null,
      notification
    });
  } catch (error) {
    console.error("upload-selfie error", error);
    return json(500, {
      error: "Internal upload error",
      code: "internal_error"
    });
  }
};
