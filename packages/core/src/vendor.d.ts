// doiuse ships no type declarations; this covers the part of its API Redline uses.
declare module 'doiuse' {
  import type { PluginCreator } from 'postcss';
  interface UsageInfo {
    feature: string;
    message: string;
    usage: { source?: { start?: { line: number; column: number } } };
  }
  const doiuse: PluginCreator<{ browsers: string[]; ignore?: string[]; onFeatureUsage?: (usage: UsageInfo) => void }>;
  export default doiuse;
}
