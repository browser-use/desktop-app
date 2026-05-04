export function mergeChromiumFeature(existingFeatures: string, feature: string): string {
  const features = existingFeatures
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (!features.includes(feature)) {
    features.push(feature);
  }

  return features.join(',');
}
