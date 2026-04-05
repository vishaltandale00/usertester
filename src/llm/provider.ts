/**
 * Provider-agnostic LLM abstraction layer
 *
 * Model string format:
 *   openrouter/openai/gpt-5.4-mini   → OpenRouter with OPENROUTER_API_KEY
 *   openrouter/anthropic/claude-opus-4-6 → OpenRouter with OPENROUTER_API_KEY
 *   anthropic/claude-opus-4-6        → direct Anthropic with ANTHROPIC_API_KEY
 *   openai/gpt-5.4-mini              → direct OpenAI with OPENAI_API_KEY
 */
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import type { UsertesterConfig } from '../types.js'

/**
 * Resolve a model string to a LanguageModel instance.
 * Returns LanguageModel (LanguageModelV2) for use with generateText/AISdkClient.
 */
export function resolveModel(
  modelString: string,
  config?: Partial<UsertesterConfig>,
): LanguageModel {
  if (modelString.startsWith('openrouter/')) {
    // e.g. "openrouter/anthropic/claude-opus-4-6" → "anthropic/claude-opus-4-6"
    const modelId = modelString.slice('openrouter/'.length)
    const apiKey =
      config?.openrouter_api_key ?? process.env.OPENROUTER_API_KEY
    const or = createOpenRouter({ apiKey })
    return or(modelId) as unknown as LanguageModel
  }

  if (modelString.startsWith('anthropic/')) {
    const modelId = modelString.slice('anthropic/'.length)
    const apiKey =
      config?.anthropic_api_key ?? process.env.ANTHROPIC_API_KEY
    const provider = createAnthropic({ apiKey })
    return provider(modelId)
  }

  if (modelString.startsWith('openai/')) {
    const modelId = modelString.slice('openai/'.length)
    const apiKey =
      config?.openai_api_key ?? process.env.OPENAI_API_KEY
    const provider = createOpenAI({ apiKey })
    return provider(modelId)
  }

  throw new Error(
    `Unknown model string format: "${modelString}". ` +
      'Expected: openrouter/<provider>/<model>, anthropic/<model>, or openai/<model>',
  )
}

/**
 * Make a single cheap LLM call. Returns the text response.
 */
export async function cheapCall(
  prompt: string,
  config?: Partial<UsertesterConfig>,
  maxTokens = 300,
): Promise<string> {
  const modelString =
    config?.orchestrator_model ?? 'openrouter/openai/gpt-5.4-mini'
  const model = resolveModel(modelString, config)

  try {
    const result = await generateText({
      model,
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens: maxTokens,
    })
    return result.text
  } catch {
    return ''
  }
}

/**
 * Make multiple cheap LLM calls in parallel. Returns an array of text responses.
 */
export async function cheapBatch(
  prompts: string[],
  config?: Partial<UsertesterConfig>,
  maxTokens = 300,
): Promise<string[]> {
  return Promise.all(prompts.map(p => cheapCall(p, config, maxTokens)))
}
