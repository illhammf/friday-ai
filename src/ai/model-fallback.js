export function getModelChain(primary, ...fallbackLists) {
  const models = [
    primary,
    ...fallbackLists.flatMap((list) => (
      Array.isArray(list) ? list : String(list || '').split(',')
    )),
  ]
    .map((model) => String(model || '').trim())
    .filter(Boolean);

  return [...new Set(models)];
}

export function isModelFallbackError(error) {
  const status = Number(error?.status || error?.code);
  const details = [
    error?.message,
    error?.status,
    error?.code,
    error?.error?.message,
    error?.error?.status,
  ]
    .filter((value) => value != null)
    .map(String)
    .join(' ');

  return (
    status === 429 ||
    [500, 502, 503, 504].includes(status) ||
    status === 404 ||
    /\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|RESOURCE_EXHAUSTED|quota exceeded|rate.?limit|UNAVAILABLE|high demand|overloaded|temporarily unavailable|model (?:was )?not found|model does not exist/i.test(details)
  );
}

export async function generateWithModelFallback(
  models,
  generate,
  {
    shouldFallback = isModelFallbackError,
    onFallback = () => {},
  } = {},
) {
  const modelChain = [...new Set(
    models.map((model) => String(model || '').trim()).filter(Boolean),
  )];

  if (modelChain.length === 0) {
    throw new Error('Daftar model Gemini kosong.');
  }

  for (let index = 0; index < modelChain.length; index++) {
    const model = modelChain[index];

    try {
      return await generate(model);
    } catch (error) {
      const nextModel = modelChain[index + 1];

      if (!nextModel || !shouldFallback(error)) {
        throw error;
      }

      onFallback({ model, nextModel, error });
    }
  }
}
