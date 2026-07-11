// LLM provider presets for direct mode (like the Jan app).
// Just enter an API key — the address and format are here. baseUrl can be overridden
// in settings (advanced) if a provider changes their endpoint.
//
// format:
//   "openai"    — POST {baseUrl}/chat/completions, GET {baseUrl}/models, Bearer
//   "anthropic" — POST {baseUrl}/v1/messages, GET {baseUrl}/v1/models, x-api-key

export const PROVIDER_PRESETS = [
  {
    id: "anthropic",
    label: "Claude (Anthropic)",
    format: "anthropic",
    baseUrl: "https://api.anthropic.com",
    models: [],
    keysUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-…",
  },
  {
    id: "openai",
    label: "ChatGPT (OpenAI)",
    format: "openai",
    baseUrl: "https://api.openai.com/v1",
    models: [],
    keysUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-…",
  },
  {
    id: "gemini",
    label: "Gemini (Google)",
    format: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: [],
    keysUrl: "https://aistudio.google.com/apikey",
    keyHint: "AIza…",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    format: "openai",
    baseUrl: "https://api.deepseek.com",
    models: [],
    keysUrl: "https://platform.deepseek.com/api_keys",
    keyHint: "sk-…",
  },
  {
    id: "zai",
    label: "Z.ai (GLM)",
    format: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    models: [],
    keysUrl: "https://z.ai/manage-apikey/apikey-list",
    keyHint: "…",
  },
  {
    id: "qwen",
    label: "Qwen (Alibaba)",
    format: "openai",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    models: [],
    keysUrl: "https://bailian.console.alibabacloud.com/?tab=model#/api-key",
    keyHint: "sk-…",
  },
  {
    id: "kimi",
    label: "Kimi (Moonshot)",
    format: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    models: [],
    keysUrl: "https://platform.moonshot.ai/console/api-keys",
    keyHint: "sk-…",
  },
];

export function getPreset(id) {
  return PROVIDER_PRESETS.find((p) => p.id === id) || null;
}
