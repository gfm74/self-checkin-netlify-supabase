const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const MAX_BASE64_BYTES = 8 * 1024 * 1024;

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

    return json(200, {
      ok: true,
      status: "stored",
      submissionId,
      filePath,
      rowId: dbRow && dbRow.id ? dbRow.id : null
    });
  } catch (error) {
    console.error("upload-selfie error", error);
    return json(500, {
      error: "Internal upload error",
      code: "internal_error"
    });
  }
};
