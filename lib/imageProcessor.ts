import sharp from 'sharp';
import { join } from 'path';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { put } from '@vercel/blob';

let fontBase64Cache: string | null = null;

export async function mergeImages(
  generatedImagePath: string,
  timestamp: string,
  name?: string,
  designation?: string
): Promise<string> {
  try {
    console.log('Merging images - generatedImagePath:', generatedImagePath);
    console.log('Text Overlay:', { name, designation });

    // Create output directory
    const isProduction = process.env.NODE_ENV === 'production';
    const publicOutputDir = join(process.cwd(), 'public', 'final');
    const tmpOutputDir = join('/tmp', 'final');
    const outputDir = isProduction ? tmpOutputDir : publicOutputDir;

    try {
      await mkdir(outputDir, { recursive: true });
    } catch (error) {
      // Directory might already exist or be read-only
    }

    // Load background image
    const backgroundPath = join(process.cwd(), 'public', 'background.png');
    const layerPath = join(process.cwd(), 'public', 'layer.png');
    console.log('Paths:', { backgroundPath, layerPath });

    // Load images and metadata
    const [bgMetadata, layerMetadata] = await Promise.all([
      sharp(backgroundPath).metadata(),
      sharp(layerPath).metadata(),
    ]);

    const bgWidth = bgMetadata.width || 1024;
    const bgHeight = bgMetadata.height || 1024;
    const layerWidth = layerMetadata.width || 1080;
    const layerHeight = layerMetadata.height || 1920;

    console.log(`Dimensions - BG: ${bgWidth}x${bgHeight}, Layer: ${layerWidth}x${layerHeight}`);

    // STEP 1: Composite generated image BEHIND layer.png
    // Auto-fit logic: Fill width 100% and constrain height to 60% for consistent poster look
    // regardless of input aspect ratio.
    const charWidth = layerWidth;
    const charHeight = Math.floor(layerHeight * 0.60); // Auto-fit height set to 60%
    const charTopOffset = 350; // Moved up slightly as requested
    const charLeftOffset = 0;

    const layerWithCharacter = await sharp(layerPath)
      .resize(layerWidth, layerHeight)
      .composite([
        {
          input: await sharp(generatedImagePath)
            .resize(charWidth, charHeight, {
              fit: 'cover',
              position: 'top'
            })
            .toBuffer(),
          blend: 'dest-over',
          top: charTopOffset,
          left: charLeftOffset
        }
      ])
      .toBuffer();

    // STEP 2: Create Text Overlay if name/designation provided
    let finalCompositeLayers: any[] = [
      {
        input: await sharp(layerWithCharacter)
          .resize(bgWidth, bgHeight, {
            fit: 'cover'
          })
          .toBuffer(),
        gravity: 'center',
        blend: 'over'
      }
    ];

    if (name || designation) {
      // Create SVG overlay for text
      // Positioning based on the white banner in the reference (approx bottom 1/4)
      const svgWidth = bgWidth;
      const svgHeight = bgHeight;

      // Cal Sans for name (approx 64px)
      // Geist for designation (approx 36px, -4% kerning)
      const nameText = name ? name.toUpperCase() : '';
      const desText = designation ? designation : '';

      // Auto-scaling logic: start with larger base size and scale down
      const maxWidth = 900; // Visible banner width
      const baseNameSize = 80;
      const baseDesSize = 42;

      // Estimate character widths (approximate for sans-serif)
      const nameEstimatedWidth = nameText.length * (baseNameSize * 0.6);
      const nameFontSize = nameEstimatedWidth > maxWidth
        ? Math.floor(baseNameSize * (maxWidth / nameEstimatedWidth))
        : baseNameSize;

      const desEstimatedWidth = desText.length * (baseDesSize * 0.5);
      const desFontSize = desEstimatedWidth > maxWidth
        ? Math.floor(baseDesSize * (maxWidth / desEstimatedWidth))
        : baseDesSize;

      // Precise coordinates for the center of the white banner area
      // Final Micro adjustment: 0.755 -> 0.752, 0.787 -> 0.784 (another 0.3% up)
      const nameY = Math.floor(svgHeight * 0.752);
      const desY = Math.floor(svgHeight * 0.784);

      // Load font if not cached
      if (!fontBase64Cache) {
        try {
          // Explicit path resolution for Vercel and Local
          const fontPath = join(process.cwd(), 'public', 'CalSans-SemiBold.ttf');
          console.log(`Attempting to load font from: ${fontPath}`);
          const fontBuffer = await readFile(fontPath);
          fontBase64Cache = fontBuffer.toString('base64');
          console.log('Font successfully loaded and cached as Base64 (Size:', fontBuffer.length, 'bytes)');
        } catch (err) {
          console.error('CRITICAL: Failed to load font for inlining:', err);
          // Don't throw, but text might look different
        }
      }

      const svgOverlay = `
        <svg width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
          <defs>
            <style>
              ${fontBase64Cache ? `
              @font-face {
                font-family: "Cal Sans";
                src: url("data:font/ttf;base64,${fontBase64Cache}");
              }
              ` : ''}
              .name {
                fill: #000000;
                font-family: "Cal Sans", "DejaVu Sans", "Arial", sans-serif;
                font-size: ${Math.max(nameFontSize, 24)}px;
                font-weight: 800;
                text-anchor: middle;
                dominant-baseline: middle;
              }
              .designation {
                fill: #222222;
                font-family: "Geist", "Inter", "DejaVu Sans", "Arial", sans-serif;
                font-size: ${Math.max(desFontSize, 18)}px;
                font-weight: 500;
                text-anchor: middle;
                dominant-baseline: middle;
                letter-spacing: -0.04em;
              }
            </style>
          </defs>
          <!-- Name and Designation rendered in white banner with auto-fitting width -->
          <text x="${svgWidth / 2}" y="${nameY}" class="name" textLength="${nameEstimatedWidth > maxWidth ? maxWidth : ''}" lengthAdjust="spacingAndGlyphs">${nameText}</text>
          <text x="${svgWidth / 2}" y="${desY}" class="designation" textLength="${desEstimatedWidth > maxWidth ? maxWidth : ''}" lengthAdjust="spacingAndGlyphs">${desText}</text>
        </svg>
      `;

      finalCompositeLayers.push({
        input: Buffer.from(svgOverlay),
        top: 0,
        left: 0,
        blend: 'over'
      });
    }

    const finalBuffer = await sharp(backgroundPath)
      .resize(bgWidth, bgHeight)
      .composite(finalCompositeLayers)
      .png()
      .toBuffer();

    // Generate filename
    const timestamp_str = timestamp.toString();
    const outputFilename = `final-${timestamp_str}.png`;

    // Save final image locally if possible (mandatory for local, optional for prod)
    try {
      const outputPath = join(outputDir, outputFilename);
      await writeFile(outputPath, finalBuffer);
      console.log('Final image saved locally:', outputPath);
    } catch (err) {
      console.warn('Could not save final image locally (likely Vercel read-only FS):', err);
      // If we're in prod and have blob, this is fine. If not, we might have an issue.
    }

    // Upload to Vercel Blob if token is available
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      console.log('Uploading to Vercel Blob...');
      const blob = await put(`posters/${outputFilename}`, finalBuffer, {
        access: 'public',
        contentType: 'image/png',
      });
      console.log('Uploaded to Vercel Blob:', blob.url);
      return blob.url;
    }

    return `/final/${outputFilename}`;
  } catch (error) {
    console.error('Error merging images:', error);
    throw new Error(`Failed to merge images: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
