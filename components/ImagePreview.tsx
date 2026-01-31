"use client";

import Image from "next/image";

interface ImagePreviewProps {
  uploadedImage: string;
  generatedImage: string | null;
  finalImage: string | null;
  loading: boolean;
  error: string | null;
  onReset: () => void;
}

export default function ImagePreview({
  uploadedImage,
  generatedImage,
  finalImage,
  loading,
  error,
  onReset,
}: ImagePreviewProps) {
  const handleDownload = () => {
    if (!finalImage) return;

    const link = document.createElement("a");
    link.href = finalImage;
    link.download = "arcane-style-image.png";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleShare = async () => {
    if (!finalImage) return;

    try {
      const response = await fetch(finalImage);
      const blob = await response.blob();
      const file = new File([blob], "arcane-style-image.png", {
        type: "image/png",
      });

      if (navigator.share && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "Arcane Style Image",
          text: "Check out my Arcane-style transformation!",
        });
      } else {
        // Fallback: copy link to clipboard
        await navigator.clipboard.writeText(window.location.href);
        alert("Link copied to clipboard!");
      }
    } catch (err) {
      console.error("Error sharing:", err);
      alert("Failed to share image");
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid md:grid-cols-2 gap-6">
        {/* Original Image */}
        <div className="space-y-2">
          <h3 className="text-lg font-semibold text-white">Original Image</h3>
          <div className="bg-gray-900 rounded-lg overflow-hidden border border-gray-700">
            <div className="relative w-full h-96">
              <Image
                src={uploadedImage}
                alt="Original"
                fill
                className="object-contain"
                unoptimized
              />
            </div>
          </div>
        </div>

        {/* Generated/Final Image */}
        <div className="space-y-2">
          <h3 className="text-lg font-semibold text-white">
            {loading ? "Generating..." : "Arcane Style"}
          </h3>
          <div className="bg-gray-900 rounded-lg overflow-hidden border border-gray-700 min-h-96 flex items-center justify-center">
            {loading ? (
              <div className="text-center space-y-4 p-8">
                <div className="animate-spin rounded-full h-16 w-16 border-b-4 border-purple-500 mx-auto"></div>
                <p className="text-gray-400">
                  Creating your Arcane-style masterpiece...
                </p>
              </div>
            ) : error ? (
              <div className="text-center p-8">
                <p className="text-red-400 mb-4">{error}</p>
                <button
                  onClick={onReset}
                  className="bg-red-600 hover:bg-red-700 text-white font-semibold py-2 px-6 rounded-lg transition-colors"
                >
                  Try Again
                </button>
              </div>
            ) : finalImage ? (
              <div className="relative w-full h-96">
                <Image
                  src={finalImage}
                  alt="Generated Arcane Style"
                  fill
                  className="object-contain"
                  unoptimized
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      {finalImage && !loading && (
        <div className="flex flex-wrap gap-4 justify-center">
          <button
            onClick={handleDownload}
            className="bg-green-600 hover:bg-green-700 text-white font-semibold py-3 px-8 rounded-lg transition-colors flex items-center gap-2"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            Download
          </button>
          <button
            onClick={handleShare}
            className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-8 rounded-lg transition-colors flex items-center gap-2"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
              />
            </svg>
            Share
          </button>
          <button
            onClick={onReset}
            className="bg-gray-600 hover:bg-gray-700 text-white font-semibold py-3 px-8 rounded-lg transition-colors"
          >
            Upload New Image
          </button>
        </div>
      )}
    </div>
  );
}
