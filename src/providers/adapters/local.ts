import { ProviderKind } from '../types.js';
import { OpenAiCompatibleAdapter } from './openai-compatible.js';

export class CustomAdapter extends OpenAiCompatibleAdapter {
  kind: ProviderKind = "custom";
}

export class LocalAdapter extends OpenAiCompatibleAdapter {
  kind: ProviderKind = "local";
}
