const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const DEFAULT_LIMIT = 30;
const DEFAULT_SIGNED_URL_SECONDS = 60 * 60 * 12;

function json(statusCode, payload) {
  return new Response(JSON.stringify(payload), {
    status: statusCode,
    headers: JSON_HEADERS
  });
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function normalizeToken(value) {
  return String(value || "").trim();
}

async function fetchCheckins({ supabaseUrl, serviceRoleKey, table, limit }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  url.searchParams.set("select", "id,submission_id,language,file_path,file_name,status,created_at,size_bytes");
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", String(limit));

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

  return response.json();
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

export default async (request) => {
  if (request.method !== "GET") {
    return json(405, { error: "Method not allowed", code: "method_not_allowed" });
  }

  try {
    const accessToken = getRequiredEnv("DASHBOARD_ACCESS_TOKEN");
    const providedToken = normalizeToken(
      new URL(request.url).searchParams.get("token") ||
      request.headers.get("x-dashboard-token")
    );

    if (!providedToken || providedToken !== accessToken) {
      return json(401, { error: "Unauthorized", code: "unauthorized" });
    }

    const supabaseUrl = getRequiredEnv("SUPABASE_URL");
    const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || "selfies";
    const table = process.env.SUPABASE_CHECKINS_TABLE || "checkin_selfies";
    const signedUrlSeconds = Number(process.env.DASHBOARD_LINK_EXPIRES_IN || DEFAULT_SIGNED_URL_SECONDS);
    const limit = Math.min(
      Number(new URL(request.url).searchParams.get("limit") || DEFAULT_LIMIT),
      100
    );

    const rows = await fetchCheckins({
      supabaseUrl,
      serviceRoleKey,
      table,
      limit
    });

    const items = await Promise.all(rows.map(async (row) => {
      let signedUrl = null;

      try {
        signedUrl = await createSignedFileUrl({
          supabaseUrl,
          serviceRoleKey,
          bucket,
          path: row.file_path,
          expiresIn: signedUrlSeconds
        });
      } catch (error) {
        console.error("dashboard signed url error", row.file_path, error);
      }

      return {
        ...row,
        signed_url: signedUrl
      };
    }));

    return json(200, {
      ok: true,
      items
    });
  } catch (error) {
    console.error("list-checkins error", error);
    return json(500, {
      error: "Internal dashboard error",
      code: "internal_error"
    });
  }
};
