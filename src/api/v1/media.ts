import { PutObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import sharp from "sharp";
import { uuidv7 } from "uuidv7-js";
import { db } from "../../db";
import { serializeMedium } from "../../entities/medium";
import { uploadThumbnail } from "../../media";
import { type Variables, scopeRequired, tokenRequired } from "../../oauth";
import { S3_BUCKET, S3_URL_BASE, s3 } from "../../s3";
import { media } from "../../schema";

const app = new Hono<{ Variables: Variables }>();

export async function postMedia(c: Context<{ Variables: Variables }>) {
  const owner = c.get("token").accountOwner;
  if (owner == null) {
    return c.json({ error: "This method requires an authenticated user" }, 422);
  }
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "file is required" }, 422);
  }
  const description = form.get("description")?.toString();
  const id = uuidv7();
  const fileBuffer = await file.arrayBuffer();
  const image = sharp(fileBuffer);
  const fileMetadata = await image.metadata();
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `media/${id}/original`,
      Body: new Uint8Array(fileBuffer),
      ContentType: file.type,
      ACL: "public-read",
    }),
  );
  const url = new URL(`media/${id}/original`, S3_URL_BASE).href;
  const result = await db
    .insert(media)
    .values({
      id,
      type: file.type,
      url,
      width: fileMetadata.width!,
      height: fileMetadata.height!,
      description,
      ...(await uploadThumbnail(id, image)),
    })
    .returning();
  if (result.length < 1) {
    return c.json({ error: "Failed to insert media" }, 500);
  }
  return c.json(serializeMedium(result[0]));
}

app.post("/", tokenRequired, scopeRequired(["write:media"]), postMedia);

app.get("/:id", async (c) => {
  const medium = await db.query.media.findFirst({
    where: eq(media.id, c.req.param("id")),
  });
  if (medium == null) return c.json({ error: "Not found" }, 404);
  return c.json(serializeMedium(medium));
});

app.put("/:id", tokenRequired, scopeRequired(["write:media"]), async (c) => {
  const mediumId = c.req.param("id");
  let description: string | undefined;
  try {
    const json = await c.req.json();
    description = json.description;
  } catch (e) {
    const form = await c.req.formData();
    description = form.get("description")?.toString();
  }
  if (description == null) {
    return c.json({ error: "description is required" }, 422);
  }
  const result = await db
    .update(media)
    .set({ description })
    .where(eq(media.id, mediumId))
    .returning();
  if (result.length < 1) return c.json({ error: "Not found" }, 404);
  return c.json(serializeMedium(result[0]));
});

export default app;
