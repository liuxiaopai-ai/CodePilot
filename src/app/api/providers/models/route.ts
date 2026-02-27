import { NextResponse } from 'next/server';
import { getAllProviders, getDefaultProviderId } from '@/lib/db';
import type { ApiProvider, ErrorResponse, ProviderModelGroup } from '@/types';

type ModelOption = { value: string; label: string };

// Default Claude model options
const DEFAULT_MODELS: ModelOption[] = [
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'opus', label: 'Opus 4.6' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

// Provider-specific model mappings (base_url -> models)
// NOTE: values here must be provider-native model IDs (not Claude aliases).
const PROVIDER_MODEL_FALLBACKS: Record<string, ModelOption[]> = {
  'https://api.z.ai/api/anthropic': [
    { value: 'glm-4.7', label: 'GLM-4.7' },
    { value: 'glm-5', label: 'GLM-5' },
    { value: 'glm-4.5-air', label: 'GLM-4.5-Air' },
  ],
  'https://open.bigmodel.cn/api/anthropic': [
    { value: 'glm-4.7', label: 'GLM-4.7' },
    { value: 'glm-5', label: 'GLM-5' },
    { value: 'glm-4.5-air', label: 'GLM-4.5-Air' },
  ],
  'https://api.kimi.com/coding': [
    { value: 'kimi-k2.5', label: 'Kimi K2.5' },
  ],
  'https://api.moonshot.ai/anthropic': [
    { value: 'kimi-k2.5', label: 'Kimi K2.5' },
  ],
  'https://api.moonshot.cn/anthropic': [
    { value: 'kimi-k2.5', label: 'Kimi K2.5' },
  ],
  'https://api.minimaxi.com/anthropic': [
    { value: 'MiniMax-M2.5', label: 'MiniMax-M2.5' },
  ],
  'https://api.minimax.io/anthropic': [
    { value: 'MiniMax-M2.5', label: 'MiniMax-M2.5' },
  ],
  // Keep OpenRouter behavior unchanged for backward compatibility
  'https://openrouter.ai/api': [
    { value: 'sonnet', label: 'Sonnet 4.6' },
    { value: 'opus', label: 'Opus 4.6' },
    { value: 'haiku', label: 'Haiku 4.5' },
  ],
};

const MODEL_FETCH_TIMEOUT_MS = 1500;

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Deduplicate models: if multiple values map to the same label, keep only the first one.
 */
export function deduplicateModels(models: ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  const result: ModelOption[] = [];
  for (const m of models) {
    if (!seen.has(m.label)) {
      seen.add(m.label);
      result.push(m);
    }
  }
  return result;
}

export function extractModelOptionsFromPayload(payload: unknown): ModelOption[] {
  let raw: unknown[] = [];

  if (Array.isArray(payload)) {
    raw = payload;
  } else if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.data)) {
      raw = record.data;
    } else if (Array.isArray(record.models)) {
      raw = record.models;
    }
  }

  const result: ModelOption[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      result.push({ value: item, label: item });
      continue;
    }

    if (!item || typeof item !== 'object') continue;

    const model = item as Record<string, unknown>;
    const id =
      (typeof model.id === 'string' && model.id) ||
      (typeof model.model === 'string' && model.model) ||
      (typeof model.name === 'string' && model.name) ||
      '';

    if (!id) continue;

    const label =
      (typeof model.name === 'string' && model.name) ||
      (typeof model.display_name === 'string' && model.display_name) ||
      (typeof model.label === 'string' && model.label) ||
      id;

    result.push({ value: id, label });
  }

  return deduplicateModels(result);
}

export function buildModelEndpointCandidates(baseUrl: string): string[] {
  const normalized = normalizeBaseUrl(baseUrl);
  const candidates = new Set<string>();

  if (!/^https?:\/\//.test(normalized)) return [];

  candidates.add(`${normalized}/v1/models`);

  // Some Anthropic-compatible providers expose /v1/models at a parent path.
  try {
    const parsed = new URL(normalized);
    if (parsed.pathname.endsWith('/anthropic')) {
      const withoutAnthropic = new URL(parsed.toString());
      withoutAnthropic.pathname = parsed.pathname.replace(/\/anthropic$/, '') || '/';
      withoutAnthropic.pathname = `${withoutAnthropic.pathname.replace(/\/+$/, '')}/v1/models`;
      candidates.add(withoutAnthropic.toString().replace(/\/+$/, ''));
    }
  } catch {
    // Ignore malformed URL
  }

  return Array.from(candidates);
}

function shouldTryDynamicModelFetch(provider: ApiProvider): boolean {
  if (!provider.base_url || !provider.api_key) return false;

  const normalized = normalizeBaseUrl(provider.base_url);

  // Keep native Anthropic and OpenRouter behavior exactly as before.
  if (normalized === 'https://api.anthropic.com') return false;
  if (normalized === 'https://openrouter.ai/api') return false;

  return true;
}

async function fetchDynamicModels(provider: ApiProvider): Promise<ModelOption[] | null> {
  if (!shouldTryDynamicModelFetch(provider)) return null;

  const endpoints = buildModelEndpointCandidates(provider.base_url);
  if (endpoints.length === 0) return null;

  const key = provider.api_key.trim();
  if (!key) return null;

  const headers: HeadersInit = {
    Accept: 'application/json',
    Authorization: `Bearer ${key}`,
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  };

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) continue;

      const data = await response.json().catch(() => null);
      const models = extractModelOptionsFromPayload(data);
      if (models.length > 0) return models;
    } catch {
      // Best-effort dynamic fetch. Fail silently and use fallback mapping.
    }
  }

  return null;
}

export function getFallbackModelsForBaseUrl(baseUrl: string): ModelOption[] {
  const normalized = normalizeBaseUrl(baseUrl || '');
  return PROVIDER_MODEL_FALLBACKS[normalized] || DEFAULT_MODELS;
}

function resolveFallbackModels(provider: ApiProvider): ModelOption[] {
  return getFallbackModelsForBaseUrl(provider.base_url || '');
}

async function resolveProviderModels(provider: ApiProvider): Promise<ModelOption[]> {
  const dynamicModels = await fetchDynamicModels(provider);
  const models = dynamicModels || resolveFallbackModels(provider);
  return deduplicateModels(models);
}

export async function GET() {
  try {
    const providers = getAllProviders();
    const groups: ProviderModelGroup[] = [];

    // Always show the built-in Claude Code provider group.
    // Claude Code CLI stores credentials in ~/.claude/ (via `claude login`),
    // which the SDK subprocess can read — even without ANTHROPIC_API_KEY in env.
    groups.push({
      provider_id: 'env',
      provider_name: 'Claude Code',
      provider_type: 'anthropic',
      models: DEFAULT_MODELS,
    });

    // Provider types that are not LLMs (e.g. image generation) — skip in chat model selector
    const MEDIA_PROVIDER_TYPES = new Set(['gemini-image']);

    // Build a group for each configured provider
    const providerGroups = await Promise.all(
      providers
        .filter((provider) => !MEDIA_PROVIDER_TYPES.has(provider.provider_type))
        .map(async (provider) => {
          const models = await resolveProviderModels(provider);
          return {
            provider_id: provider.id,
            provider_name: provider.name,
            provider_type: provider.provider_type,
            models,
          };
        })
    );

    groups.push(...providerGroups);

    // Determine default provider
    const defaultProviderId = getDefaultProviderId() || groups[0].provider_id;

    return NextResponse.json({
      groups,
      default_provider_id: defaultProviderId,
    });
  } catch (error) {
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to get models' },
      { status: 500 }
    );
  }
}
