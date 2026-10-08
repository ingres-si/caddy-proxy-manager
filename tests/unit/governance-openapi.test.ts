/**
 * OpenAPI for the governance and operations endpoints: every new endpoint is
 * documented with an operation id and its references resolve.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/src/lib/api-auth', () => ({
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
  apiErrorResponse: vi.fn(),
}));

import { GET } from '@/app/api/v1/openapi.json/route';

const EXPECTED: Record<string, string[]> = {
  '/api/v1/audit-log': ['get'],
  '/api/v1/audit-log/{id}': ['get'],
  '/api/v1/audit-log/facets': ['get'],
  '/api/v1/alert-events/firing': ['get'],
  '/api/v1/certificates/managed': ['get'],
  '/api/v1/config-history/versions': ['get'],
  '/api/v1/config-history/compare': ['get'],
  '/api/v1/config-history/{id}/rollback-preview': ['get'],
  '/api/v1/setup-checklist': ['get', 'put'],
  '/api/v1/overview/attention': ['get'],
  '/api/v1/compliance/controls/status': ['get'],
  '/api/v1/compliance/schedules': ['get', 'post'],
  '/api/v1/compliance/schedules/{id}': ['get', 'put', 'delete'],
  '/api/v1/compliance/schedules/{id}/run': ['post'],
  '/api/v1/compliance/packs': ['get'],
  '/api/v1/compliance/restore-tests': ['get', 'post'],
  '/api/v1/compliance/restore-tests/{id}': ['delete'],
  '/api/v1/access-reviews/{id}/evidence': ['get'],
  '/api/v1/access-review-assignments/evidence': ['get'],
};

describe('OpenAPI: governance and operations', () => {
  it('documents every endpoint and every reference resolves', async () => {
    const spec = await (await GET({ headers: { get: () => null } } as any)).json();
    const operationIds = new Set<string>();
    for (const [path, methods] of Object.entries(EXPECTED)) {
      expect(spec.paths[path], path).toBeDefined();
      expect(Object.keys(spec.paths[path]).sort(), path).toEqual([...methods].sort());
      for (const method of methods) {
        expect(spec.paths[path][method].operationId, `${method} ${path}`).toBeTruthy();
        expect(spec.paths[path][method].tags.length, `${method} ${path}`).toBe(1);
        operationIds.add(spec.paths[path][method].operationId);
      }
    }
    expect(operationIds.size).toBe(Object.values(EXPECTED).flat().length);
    expect(spec.tags.map((tag: { name: string }) => tag.name)).toEqual(expect.arrayContaining(['Overview', 'Setup']));

    const documented = JSON.stringify(Object.fromEntries(Object.keys(EXPECTED).map((path) => [path, spec.paths[path]])));
    const pending = [...documented.matchAll(/"\$ref":"(#\/components\/[^"]+)"/g)].map((match) => match[1]);
    const seen = new Set<string>();
    while (pending.length > 0) {
      const ref = pending.pop()!;
      if (seen.has(ref)) continue;
      seen.add(ref);
      const node = ref.slice(2).split('/').reduce((value: any, key: string) => value?.[key], spec);
      expect(node, ref).toBeDefined();
      for (const match of JSON.stringify(node).matchAll(/"\$ref":"(#\/components\/[^"]+)"/g)) pending.push(match[1]);
    }
    expect(seen.size).toBeGreaterThan(20);
  });

  it('documents the alert rule scope, "for" duration and the error rate rule', async () => {
    const spec = await (await GET({ headers: { get: () => null } } as any)).json();
    const schemas = spec.components.schemas;
    expect(schemas.AlertRule.properties.type.enum).toContain('error_rate');
    expect(schemas.AlertRuleInput.properties).toHaveProperty('scope');
    expect(schemas.AlertRuleInput.properties.forMinutes.maximum).toBe(1440);
    expect(schemas.AlertRuleParams.properties).toHaveProperty('thresholdPercent');
    expect(schemas.AlertRuleParams.properties).toHaveProperty('includeManagedCertificates');
    expect(schemas.ChangeRequest.properties).toHaveProperty('impact');
    expect(schemas.AuditLogEvent.properties).toHaveProperty('configChange');
    const parameters = spec.paths['/api/v1/audit-log'].get.parameters.map((parameter: { name?: string }) => parameter.name);
    expect(parameters).toEqual(expect.arrayContaining(['actor', 'action', 'entityType', 'entityId', 'from', 'to', 'search']));
  });
});
