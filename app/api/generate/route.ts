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
      'Reimagine the uploaded person as a cinematic, high-end superhero portrait inspired by modern DC-style realism, presented as an upper-body portrait cropped from just below the waist to just above the head in a consistent 4:5 aspect ratio, with the subject placed slightly off-center and facing diagonally upward, the head subtly tilted up and to the side, eyes looking toward a bright light source above, conveying a strong yet calm posture with the chest slightly forward and shoulders relaxed, and an expression that feels hopeful, confident, and aspirational with a soft, determined smile and a composed heroic presence, never aggressive. Identity preservation is critical: maintain the person’s exact facial structure, proportions, and likeness with absolute accuracy, preserving all personal features exactly as they appear in the source image, including glasses (same style, shape, and placement), nose rings, earrings, piercings, tattoos (same design, placement, and visibility), scars, moles, freckles, birthmarks, and facial hair, without adding, removing, stylizing, idealizing, beautifying, or altering any personal features beyond realistic cinematic lighting, and without changing age, gender, ethnicity, or body proportions. If the uploaded image includes culturally, religiously, or personally significant garments or coverings such as a hijab, turban, dupatta, headscarf, veil, cap, or modest or symbolic clothing, the final image must retain equivalent coverage over the same areas of the body, with the superhero suit intelligently adapted to integrate these elements or provide appropriate coverage without removing, reducing, reinterpreting, or altering their meaning or purpose. The character wears a sleek, form-fitting deep blue superhero suit with premium textured fabric, realistic tension, and visible stitching, with the overall style randomly resembling either a heroic cloth-based design, a darker and heavier power-driven suit, or a tactical armored build, and featuring a bold red and yellow geometric emblem on the chest using an upward-pointing arrow as the symbol itself, seamlessly integrated into the suit. Lighting is dramatic and cinematic with a strong rim light from above and behind, warm golden highlights wrapping naturally around the face and upper torso, subtle light streaks and glow interacting realistically with the subject, smooth color gradients, and natural, accurate skin tones, rendered in a hyper-realistic, movie-poster quality style with ultra-sharp facial detail, visible skin texture, shallow depth of field, and the subject perfectly in focus. The background must be completely removed and delivered as a transparent PNG with a clean alpha channel showing only the character, ensuring clean edges with no halos, fringing, or artifacts, maintaining strict consistency across generations with the same pose, angle, framing, and lighting, and outputting in true 4K resolution with ultra-detailed clarity.';

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

