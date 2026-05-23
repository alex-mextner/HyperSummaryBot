// Set all required environment variables so that modules calling loadConfig() at top level don't crash
process.env.BOT_TOKEN = "test-bot-token";
process.env.BOT_USERNAME = "test_bot";
process.env.ZAI_API_KEY = "test-zai-key";
process.env.ZAI_BASE_URL = "https://test.z.ai";
process.env.ZAI_MODEL = "test-zai-model";
process.env.ZAI_FAST_MODEL = "test-zai-fast";
process.env.HF_TOKEN = "test-hf-token";
process.env.HF_BASE_URL = "https://test.hf.co";
process.env.HF_MODEL = "test-hf-model";
process.env.HF_FAST_MODEL = "test-hf-fast";
process.env.GEMINI_API_KEY = "test-gem-key";
process.env.GEMINI_BASE_URL = "https://test.gemini";
process.env.GEMINI_MODEL = "test-gem-model";
process.env.GEMINI_FAST_MODEL = "test-gem-fast";

process.env.GROQ_API_KEY = "test-groq-key";
process.env.GROQ_MODEL = "test-groq-model";
process.env.GROQ_FAST_MODEL = "test-groq-fast";

process.env.MTPROTO_API_ID = "31496323";
process.env.MTPROTO_API_HASH = "e345f63982415e960843085806219f2f";

// Helpers for gramio mock tests
export const gramioApiCalls: { method: string; [key: string]: unknown }[] = [];
export let gramioNextMessageId = 1;

export function resetGramioMocks() {
  gramioApiCalls.length = 0;
  gramioNextMessageId = 1;
}

export function createMockBot() {
  return {
    api: {
      sendMessage: async (opts: any) => {
        gramioApiCalls.push({ method: "sendMessage", ...opts });
        return { message_id: gramioNextMessageId++ };
      },
      editMessageText: async (opts: any) => {
        gramioApiCalls.push({ method: "editMessageText", ...opts });
        return true;
      },
      deleteMessage: async (opts: any) => {
        gramioApiCalls.push({ method: "deleteMessage", ...opts });
        return true;
      },
      sendChatAction: async () => true,
      getFile: async () => ({ file_path: "test.ogg" }),
      setMyCommands: async () => true,
    },
  };
}
