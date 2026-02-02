import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { mergeImages } from '@/lib/imageProcessor';
import { getSupabaseClient } from '@/lib/supabase';
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

    const supabase = getSupabaseClient();

    // Upload to Supabase Storage
    console.log('Uploading input to Supabase Storage...');
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('generated-images')
      .upload(`uploads/${filename}`, buffer, {
        contentType: image.type,
        upsert: false
      });

    if (uploadError) {
      console.error('Supabase upload error:', uploadError);
    } else {
      const { data: { publicUrl } } = supabase.storage
        .from('generated-images')
        .getPublicUrl(`uploads/${filename}`);
      uploadedImageUrl = publicUrl;
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
      'Reimagine the given person as a cinematic, high-end superhero portrait inspired by modern DC-style realism, presented as an upper-body portrait cropped from just below the waist to just above the head, with the subject placed slightly off-center and facing slightly diagonally upward. The head should be subtly tilted up and to the side, with the eyes looking toward a bright light source above, conveying a strong yet calm posture with the chest slightly forward and shoulders relaxed. The expression must feel hopeful, confident, and aspirational, with a soft, determined smile and a calm heroic presence—never aggressive. Identity preservation is critical: the person’s exact facial structure, proportions, and likeness must be maintained, with all personal features preserved exactly as they are, including glasses (same style, shape, and placement), nose rings, earrings, piercings, tattoos (same design, placement, and visibility), scars, moles, freckles, birthmarks, and facial hair. Do not add, remove, stylize, idealize, or beautify any personal features beyond realistic cinematic lighting. The character should wear a sleek, form-fitting deep blue superhero suit with premium textured fabric, realistic tension, and visible stitching, and the suit’s overall style should randomly resemble either a heroic cloth-based look, a darker and heavier power-driven look, or a tactical armored look. The chest must feature a bold red and yellow geometric emblem using an upward-pointing arrow as the symbol itself, integrated naturally into the suit. Lighting should be dramatic and cinematic, with a strong rim light from above and behind, warm golden highlights wrapping around the face and upper torso, soft light streaks and glow interacting naturally with the character, smooth color gradients, and natural, realistic skin tones. The overall style must be hyper-realistic and movie-poster quality, with ultra-sharp facial details and skin texture, shallow depth of field, the subject perfectly in focus, and professional studio-grade lighting and cinematic color grading. The background must be fully removed and delivered as a transparent PNG with a clean alpha channel, showing only the character with no scenery, gradients, or background elements. Maintain strict consistency across generations with the same pose, angle, framing, and lighting, make no changes to age, gender, ethnicity, or body proportions, and render in 4K resolution with ultra-detailed clarity, clean edges, and no halos or artifacts.';

    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY not configured');
    }

    // Call OpenRouter
    console.log('Sending prompt to OpenRouter:', prompt.substring(0, 100) + '...');
    console.time('OpenRouter_AI_Call');
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
      console.timeEnd('OpenRouter_AI_Call');
      let errorDetail = 'Unknown error';
      try {
        const errorData = await apiResponse.json();
        errorDetail = JSON.stringify(errorData);
        console.error('OpenRouter API Error Details:', errorDetail);
      } catch (e) { }
      throw new Error(`OpenRouter Error ${apiResponse.status}: ${errorDetail}`);
    }

    const result = await apiResponse.json();
    console.timeEnd('OpenRouter_AI_Call');
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

    // Upload to Supabase Storage
    console.log('Uploading generated image to Supabase Storage...');
    const { data: genData, error: genError } = await supabase.storage
      .from('generated-images')
      .upload(`generated/${generatedFilename}`, imageBuffer, {
        contentType: 'image/png',
        upsert: false
      });

    if (genError) {
      console.error('Supabase generated upload error:', genError);
    } else {
      const { data: { publicUrl } } = supabase.storage
        .from('generated-images')
        .getPublicUrl(`generated/${generatedFilename}`);
      finalGeneratedUrl = publicUrl;
    }

    // Merge with background
    // Pass the /tmp path for processing
    const finalImagePath = await mergeImages(tempGeneratedFile, timestamp.toString(), name, designation);

    // Save metadata to Supabase database
    const { data: dbData, error: dbError } = await supabase
      .from('generations')
      .insert({
        name: name || 'Unknown',
        designation: designation || 'Unknown',
        image_url: finalImagePath
      })
      .select()
      .single();

    if (dbError) {
      console.error('Database insert error:', dbError);
    } else {
      console.log('Saved to database:', dbData);
    }

    return NextResponse.json({
      success: true,
      uploadedImage: uploadedImageUrl,
      generatedImage: finalGeneratedUrl,
      finalImage: finalImagePath,
      dbId: dbData?.id
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

