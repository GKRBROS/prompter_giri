import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { mergeImages } from '@/lib/imageProcessor';
import { put } from '@vercel/blob';
import OpenAI from 'openai';
import sharp from 'sharp';

export async function POST(request: NextRequest) {
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

    // Define paths
    const isProduction = process.env.NODE_ENV === 'production';
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

    // ... (rest of the prompt and API call stays same) ...
    // Note: I'm keeping the prompt/API logic identical to preserve performance.

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
    console.error('Error generating image:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to generate image' },
      { status: 500 }
    );
  }
}

