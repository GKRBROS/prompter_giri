import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { mergeImages } from '@/lib/imageProcessor';
import { put } from '@vercel/blob';
import OpenAI from 'openai';
import sharp from 'sharp';

export const maxDuration = 60; // Increase timeout for long AI generation

export async function POST(request: NextRequest) {
  const isProduction = process.env.NODE_ENV === 'production';
  try {
    const formData = await request.formData();
    const image = formData.get('image') as File;
    const name = formData.get('name') as string;
    const designation = formData.get('designation') as string;

    if (!image) {
      return NextResponse.json(
        { error: 'No image provided' },
        { status: 400 }
      );
    }

    // Save uploaded image temporarily for local processing
    const bytes = await image.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const timestamp = Date.now();
    const filename = `upload-${timestamp}.${image.name.split('.').pop()}`;

    const tmpUploadsPath = join('/tmp', 'uploads');
    const publicUploadsPath = join(process.cwd(), 'public', 'uploads');

    // Save to /tmp for intermediate processing (always works on Vercel)
    await mkdir(tmpUploadsPath, { recursive: true }).catch(() => { });
    const tempUploadFile = join(tmpUploadsPath, filename);
    await writeFile(tempUploadFile, buffer);

    // Save locally for debug/local preview (optional and non-blocking in prod)
    let uploadedImageUrl = `/uploads/${filename}`;
    if (!isProduction) {
      try {
        await mkdir(publicUploadsPath, { recursive: true }).catch(() => { });
        await writeFile(join(publicUploadsPath, filename), buffer);
      } catch (err) {
        console.warn('Could not save to public/uploads (read-only FS):', err);
      }
    }

    // Upload to Blob if token is available
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      console.log('Uploading input to Vercel Blob...');
      const blob = await put(`uploads/${filename}`, buffer, {
        access: 'public',
        contentType: image.type,
      });
      uploadedImageUrl = blob.url;
    }

    // Resize image for OpenRouter
    console.log('Resizing input image for OpenRouter...');
    const resizedBuffer = await sharp(buffer)
      .resize(1024, 1024, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 85 })
      .toBuffer();

    const base64Image = resizedBuffer.toString('base64');
    const dataUrl = `data:image/jpeg;base64,${base64Image}`;

    // Call OpenRouter
    const prompt =
      'Reimagine the given person as a cinematic, high-end superhero portrait inspired by modern DC-style realism, presented as an upper-body portrait cropped from just below the waist to just above the head, with the subject placed slightly off-center and facing slightly diagonally upward. The head should be subtly tilted up and to the side, with the eyes looking toward a bright light source above, conveying a strong yet calm posture with the chest slightly forward and shoulders relaxed. The expression must feel hopeful, confident, and aspirational, with a soft, determined smile and a calm heroic presence—never aggressive. Identity preservation is critical: the person’s exact facial structure, proportions, and likeness must be maintained, with all personal features preserved exactly as they are, including glasses (same style, shape, and placement), nose rings, earrings, piercings, tattoos (same design, placement, and visibility), scars, moles, freckles, birthmarks, and facial hair. Do not add, remove, stylize, or alter any personal features, and do not beautify or idealize beyond realistic cinematic lighting. The character should wear a sleek, form-fitting superhero suit made of deep blue textured fabric with subtle micro-pattern detailing, featuring a bold red and yellow geometric emblem on the chest; the suit should feel premium, modern, and cinematic, with realistic fabric tension and visible stitching. Lighting should be dramatic and cinematic, with a strong rim light from above and behind, warm golden highlights wrapping around the face and upper torso, soft light streaks and glow interacting naturally with the character, lighting with smooth color gradients, and natural, realistic skin tones. The overall style must be hyper-realistic and movie-poster quality, with ultra-sharp facial details and skin texture, shallow depth of field, the subject perfectly in focus, and professional studio-grade lighting and color grading. The background must be fully removed, delivered as a transparent PNG with an alpha channel, showing only the character with no scenery or gradients. Maintain strict consistency across generations with the same pose, angle, and lighting, and make no changes to age, gender, ethnicity, or body proportions. Render in 4K resolution with ultra-detailed clarity, clean edges, and no halos or artifacts.';

    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY not configured');
    }

    const apiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sourceful/riverflow-v2-fast-preview',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUrl } }
            ],
          },
        ],
        modalities: ['image']
      }),
    });

    if (!apiResponse.ok) {
      const errorData = await apiResponse.json();
      throw new Error(`OpenRouter Error: ${apiResponse.status}`);
    }

    const result = await apiResponse.json();
    const responseMessage = result.choices[0].message;
    let generatedImageUrl: string | undefined = responseMessage.images?.[0]?.image_url?.url;

    if (!generatedImageUrl) {
      throw new Error('No image returned from AI');
    }

    // Process AI Image
    let imageBuffer: Buffer;
    if (generatedImageUrl.startsWith('data:')) {
      imageBuffer = Buffer.from(generatedImageUrl.split(',')[1], 'base64');
    } else {
      const imageResponse = await fetch(generatedImageUrl);
      imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    }

    // Save intermediate image
    const generatedFilename = `generated-${timestamp}.png`;
    let finalGeneratedUrl = `/generated/${generatedFilename}`;

    // Save to /tmp
    const tmpGeneratedPath = join('/tmp', 'generated');
    await mkdir(tmpGeneratedPath, { recursive: true }).catch(() => { });
    const tempGeneratedFile = join(tmpGeneratedPath, generatedFilename);
    await writeFile(tempGeneratedFile, imageBuffer);

    // Optional local save
    if (!isProduction) {
      try {
        const publicGeneratedPath = join(process.cwd(), 'public', 'generated');
        await mkdir(publicGeneratedPath, { recursive: true }).catch(() => { });
        await writeFile(join(publicGeneratedPath, generatedFilename), imageBuffer);
      } catch (err) {
        console.warn('Could not save to public/generated (read-only FS):', err);
      }
    }

    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const blob = await put(`generated/${generatedFilename}`, imageBuffer, {
        access: 'public',
        contentType: 'image/png',
      });
      finalGeneratedUrl = blob.url;
    }

    // Merge with background
    // Pass the /tmp path for processing
    const finalImagePath = await mergeImages(tempGeneratedFile, timestamp.toString(), name, designation);

    return NextResponse.json({
      success: true,
      uploadedImage: uploadedImageUrl,
      generatedImage: finalGeneratedUrl,
      finalImage: finalImagePath,
    });
  } catch (error: any) {
    console.error('CRITICAL ERROR during generation:', error);
    // Log stack trace for Vercel logs
    if (error.stack) console.error(error.stack);

    return NextResponse.json(
      {
        error: error?.message || 'Internal Server Error',
        details: isProduction ? undefined : error?.stack
      },
      { status: 500 }
    );
  }
}

