// One entry point for every source: hand it the file's text and it works
// out what it is. JSON or YAML; OpenAPI, Swagger, HAR or Postman.

import yaml from 'js-yaml';
import type { Project } from '../../shared/project';
import { importOpenApi, isOpenApi } from './openapi';
import { importHar, isHar } from './har';
import { importPostman, isPostman } from './postman';
import { importWsdl, isWsdl } from './wsdl';

export function parseDocument(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) {
    throw new Error('That is XML but not a WSDL. For a SOAP service, import its WSDL (often the service address with ?wsdl), or record its calls.');
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`That looks like JSON but does not parse: ${(e as Error).message}`);
    }
  }
  try {
    return yaml.load(trimmed, { schema: yaml.JSON_SCHEMA });
  } catch (e) {
    throw new Error(`Not JSON, and not YAML either: ${(e as Error).message.split('\n')[0]}`);
  }
}

export function importText(text: string, ref?: string): Project {
  if (isWsdl(text)) return importWsdl(text, ref);
  const doc = parseDocument(text);
  if (isOpenApi(doc)) return importOpenApi(doc as Record<string, unknown>, ref);
  if (isHar(doc)) return importHar(doc as Record<string, any>, ref);
  if (isPostman(doc)) return importPostman(doc as Record<string, any>, ref);
  const d = doc as Record<string, unknown> | null;
  if (d && typeof d === 'object' && 'overapi' in d) throw new Error('That is already an overapi project. Open it instead of importing it.');
  throw new Error('Not a format overapi knows. It takes OpenAPI 3, Swagger 2, a WSDL, a HAR capture, or a Postman v2 collection.');
}
