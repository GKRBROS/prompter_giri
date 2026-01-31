"use client";

import { useState } from "react";
import Image from "next/image";
import ImageUpload from "./ImageUpload";
import ImagePreview from "./ImagePreview";

export default function ImageGenerator() {
  const [name, setName] = useState("");
  const [designation, setDesignation] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadedImagePreview, setUploadedImagePreview] = useState<string | null>(null);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [finalImage, setFinalImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileSelect = (file: File) => {
    setSelectedFile(file);
    setError(null);
    const reader = new FileReader();
    reader.onloadend = () => {
      setUploadedImagePreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleGenerate = async () => {
    if (!name.trim()) {
      setError("Please enter a name");
      return;
    }
    if (!designation.trim()) {
      setError("Please enter a designation");
      return;
    }
    if (!selectedFile) {
      setError("Please upload an image first");
      return;
    }

    setError(null);
    setLoading(true);
    setGeneratedImage(null);
    setFinalImage(null);

    try {
      const formData = new FormData();
      formData.append("image", selectedFile);
      formData.append("name", name);
      formData.append("designation", designation);

      const response = await fetch("/api/generate", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to generate image");
      }

      const data = await response.json();
      setGeneratedImage(data.generatedImage);
      setFinalImage(data.finalImage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setSelectedFile(null);
    setUploadedImagePreview(null);
    setGeneratedImage(null);
    setFinalImage(null);
    setError(null);
  };

  const isFormValid = name.trim() !== "" && designation.trim() !== "" && selectedFile !== null;

  return (
    <div className="bg-gray-800/40 backdrop-blur-md rounded-3xl p-6 md:p-10 shadow-3xl border border-white/10 transition-all duration-300">
      {!finalImage ? (
        <div className="space-y-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-blue-300 uppercase tracking-wider">Full Name</label>
              <input
                type="text"
                placeholder="e.g. MOHANLAL"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-blue-300 uppercase tracking-wider">Designation</label>
              <input
                type="text"
                placeholder="e.g. Actor & Producer"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                value={designation}
                onChange={(e) => setDesignation(e.target.value)}
              />
            </div>
          </div>
          
          <div className="pt-4 border-t border-white/5">
            {uploadedImagePreview ? (
              <div className="space-y-6 text-center">
                <div className="relative inline-block group">
                  <Image 
                    src={uploadedImagePreview} 
                    alt="Preview" 
                    width={192}
                    height={192}
                    className="w-48 h-48 object-cover rounded-2xl border-2 border-blue-500/30"
                    unoptimized
                  />
                  <button 
                    onClick={() => { setSelectedFile(null); setUploadedImagePreview(null); }}
                    className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1.5 opacity-0 group-hover:opacity-100 transition-opacity shadow-lg"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <p className="text-blue-400 font-medium">Image Selected! ✨</p>
              </div>
            ) : (
              <ImageUpload onImageUpload={handleFileSelect} />
            )}
          </div>

          <div className="space-y-4">
            {error && (
              <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm text-center">
                {error}
              </div>
            )}
            
            <button
              onClick={handleGenerate}
              disabled={!isFormValid || loading}
              className={`w-full py-4 rounded-xl font-bold text-lg tracking-wider transition-all duration-300 flex items-center justify-center gap-3
                ${isFormValid && !loading
                  ? 'bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 shadow-[0_0_20px_rgba(37,99,235,0.4)] text-white'
                  : 'bg-white/5 text-gray-500 border border-white/10 cursor-not-allowed'
                }`}
            >
              {loading ? (
                <>
                  <svg className="animate-spin h-6 w-6 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <span>GENERATING POSTER...</span>
                </>
              ) : (
                'GENERATE POSTER'
              )}
            </button>
          </div>
        </div>
      ) : (
        <ImagePreview
          uploadedImage={uploadedImagePreview || ""}
          generatedImage={generatedImage}
          finalImage={finalImage}
          loading={loading}
          error={error}
          onReset={handleReset}
        />
      )}
    </div>
  );
}
