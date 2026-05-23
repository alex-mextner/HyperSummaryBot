import { groqClient } from "./clients";

export interface TranscriptionResult {
  text: string;
  language?: string;
}

export async function transcribeAudio(audioBuffer: ArrayBuffer): Promise<TranscriptionResult> {
  const client = groqClient();

  // Create a File-like object from ArrayBuffer
  const file = new File([audioBuffer], "audio.ogg", { type: "audio/ogg" });

  const response = await client.audio.transcriptions.create({
    file: file as any, // OpenAI SDK accepts File/Blob
    model: "whisper-large-v3",
    response_format: "json",
  });

  return {
    text: response.text,
    language: (response as any).language,
  };
}
