import { get, put } from "@vercel/blob";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WAITLIST_PATH = "android-waitlist.json";
const MAX_STORAGE_ATTEMPTS = 5;

function parseBody(body) {
  if (typeof body !== "string") return body ?? {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

async function readWaitlist() {
  const storedWaitlist = await get(WAITLIST_PATH, {
    access: "private",
    useCache: false
  });

  if (!storedWaitlist) return { entries: [], etag: null };

  const contents = await new Response(storedWaitlist.stream).text();
  const entries = JSON.parse(contents);

  if (!Array.isArray(entries)) {
    throw new TypeError("Stored Android waitlist is not a JSON array");
  }

  return { entries, etag: storedWaitlist.blob.etag };
}

async function addToWaitlist(record) {
  for (let attempt = 0; attempt < MAX_STORAGE_ATTEMPTS; attempt += 1) {
    try {
      const { entries, etag } = await readWaitlist();

      if (entries.some((entry) => entry?.email === record.email)) return;

      const options = {
        access: "private",
        allowOverwrite: Boolean(etag),
        contentType: "application/json",
        cacheControlMaxAge: 60
      };

      // Prevent two simultaneous submissions from overwriting each other.
      if (etag) options.ifMatch = etag;

      await put(WAITLIST_PATH, JSON.stringify([...entries, record], null, 2), options);
      return;
    } catch (error) {
      if (attempt === MAX_STORAGE_ATTEMPTS - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ success: false, message: "Method not allowed" });
  }

  const body = parseBody(request.body);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const honeypot = typeof body.website === "string" ? body.website.trim() : "";

  // Quietly accept bot submissions so the endpoint does not teach bots how to bypass it.
  if (honeypot) return response.status(200).json({ success: true });

  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return response.status(400).json({ success: false, message: "Enter a valid email address" });
  }

  const record = {
    email,
    joinedAt: new Date().toISOString(),
    source: "gotem website — Google Play waitlist"
  };

  try {
    await addToWaitlist(record);
    return response.status(200).json({ success: true });
  } catch (error) {
    console.error("Android waitlist storage failed", error);
    return response.status(503).json({ success: false, message: "Waitlist temporarily unavailable" });
  }
}
