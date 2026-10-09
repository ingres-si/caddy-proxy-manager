/**
 * OWASP CRS tuning (paranoia level, detection level, anomaly thresholds,
 * over-the-threshold action) and rule exclusions as Coraza directives:
 * validation and ranges, the directives written and their order around the
 * CRS include, and that nothing out of range or user-written reaches
 * SecLang.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildWafHandler, filterCustomDirectives, listDroppedWafDirectives, RAW_BODY_RULE, RAW_BODY_RULE_ID, resolveEffectiveWaf, wafExclusionsForHost } from '../../src/lib/caddy-waf';
import {
  ANOMALY_EVALUATION_RULE_IDS,
  crsTuningDirectives,
  DEFAULT_WAF_TUNING,
  resolveWafTuning,
  storedWafTuning,
  wafTuningError,
} from '../../src/lib/waf-tuning';
import type { WafSettings } from '../../src/lib/settings';

const crsWaf: WafSettings = {
  enabled: true,
  mode: 'On',
  load_owasp_crs: true,
  custom_directives: '',
};

function directivesOf(waf: WafSettings, exclusions: Parameters<typeof buildWafHandler>[2] = []): string[] {
  return (buildWafHandler(waf, 'test', exclusions).directives as string).split('\n');
}

describe('wafTuningError', () => {
  it('accepts absent, null and in-range values', () => {
    expect(wafTuningError({})).toBeNull();
    expect(wafTuningError({ paranoia_level: null, anomaly_action: null })).toBeNull();
    expect(wafTuningError({
      paranoia_level: 2,
      detection_paranoia_level: 3,
      inbound_anomaly_threshold: 1,
      outbound_anomaly_threshold: 10_000,
      anomaly_action: 'log',
    })).toBeNull();
  });

  it.each([
    [{ paranoia_level: 0 }, /paranoia_level must be an integer from 1 to 4/],
    [{ paranoia_level: 5 }, /paranoia_level must be an integer from 1 to 4/],
    [{ paranoia_level: 1.5 }, /paranoia_level/],
    [{ paranoia_level: '2' }, /paranoia_level/],
    [{ detection_paranoia_level: 9 }, /detection_paranoia_level must be an integer/],
    [{ paranoia_level: 3, detection_paranoia_level: 2 }, /must not be lower than waf.paranoia_level/],
    [{ inbound_anomaly_threshold: 0 }, /inbound_anomaly_threshold must be an integer from 1 to 10000/],
    [{ inbound_anomaly_threshold: 10_001 }, /inbound_anomaly_threshold/],
    [{ outbound_anomaly_threshold: '4\nSecRuleEngine Off' }, /outbound_anomaly_threshold/],
    [{ outbound_anomaly_threshold: Number.NaN }, /outbound_anomaly_threshold/],
    [{ anomaly_action: 'deny' }, /anomaly_action must be block or log/],
  ])('rejects %j', (value, message) => {
    expect(wafTuningError(value as Record<string, unknown>)).toMatch(message);
  });

  it('checks the detection level against the default blocking level when none is given', () => {
    expect(wafTuningError({ detection_paranoia_level: 1 })).toBeNull();
    expect(wafTuningError({ detection_paranoia_level: 4 })).toBeNull();
  });
});

describe('resolveWafTuning', () => {
  it('is the CRS default without settings', () => {
    expect(resolveWafTuning(null)).toEqual({
      paranoiaLevel: 1,
      detectionParanoiaLevel: 1,
      inboundThreshold: 5,
      outboundThreshold: 4,
      anomalyAction: 'block',
    });
  });

  it('falls back to the default for stored values out of range or of the wrong type', () => {
    const tuning = resolveWafTuning({
      paranoia_level: 7,
      detection_paranoia_level: '3' as unknown as number,
      inbound_anomaly_threshold: -5,
      outbound_anomaly_threshold: 2.5,
      anomaly_action: 'drop' as never,
    });
    expect(tuning).toEqual(DEFAULT_WAF_TUNING);
  });

  it('never runs a detection level below the blocking level', () => {
    expect(resolveWafTuning({ paranoia_level: 3, detection_paranoia_level: 2 }).detectionParanoiaLevel).toBe(3);
  });
});

describe('storedWafTuning', () => {
  it('keeps only values that differ from the CRS defaults', () => {
    expect(storedWafTuning({ paranoia_level: 1, detection_paranoia_level: 1, inbound_anomaly_threshold: 5, outbound_anomaly_threshold: 4, anomaly_action: 'block' })).toEqual({});
    expect(storedWafTuning({ paranoia_level: 2, detection_paranoia_level: 3, inbound_anomaly_threshold: 10, anomaly_action: 'log' })).toEqual({
      paranoia_level: 2,
      detection_paranoia_level: 3,
      inbound_anomaly_threshold: 10,
      anomaly_action: 'log',
    });
  });
});

describe('crsTuningDirectives', () => {
  it('writes nothing for the defaults', () => {
    expect(crsTuningDirectives(DEFAULT_WAF_TUNING)).toEqual({ beforeRules: [], afterRules: [], ruleIds: [] });
  });

  it('sets the CRS variables with the ids of crs-setup.conf.example', () => {
    const { beforeRules, ruleIds } = crsTuningDirectives(resolveWafTuning({
      paranoia_level: 2,
      detection_paranoia_level: 3,
      inbound_anomaly_threshold: 12,
      outbound_anomaly_threshold: 8,
    }));
    expect(beforeRules).toEqual([
      'SecAction "id:900000,phase:1,pass,t:none,nolog,setvar:tx.blocking_paranoia_level=2"',
      'SecAction "id:900001,phase:1,pass,t:none,nolog,setvar:tx.detection_paranoia_level=3"',
      'SecAction "id:900110,phase:1,pass,t:none,nolog,setvar:tx.inbound_anomaly_score_threshold=12,setvar:tx.outbound_anomaly_score_threshold=8"',
    ]);
    expect(ruleIds).toEqual([900000, 900001, 900110]);
  });

  it('writes only the threshold that changed', () => {
    expect(crsTuningDirectives(resolveWafTuning({ outbound_anomaly_threshold: 9 })).beforeRules).toEqual([
      'SecAction "id:900110,phase:1,pass,t:none,nolog,setvar:tx.outbound_anomaly_score_threshold=9"',
    ]);
  });

  it('turns the anomaly evaluation rules into pass for log only', () => {
    const { afterRules } = crsTuningDirectives(resolveWafTuning({ anomaly_action: 'log' }));
    expect(afterRules).toEqual(ANOMALY_EVALUATION_RULE_IDS.map((id) => `SecRuleUpdateActionById ${id} "pass"`));
  });

  it('re-checks values instead of trusting the tuning object', () => {
    const hostile = {
      paranoiaLevel: '2"\nSecRuleEngine Off\n#' as unknown as 1,
      detectionParanoiaLevel: 99 as unknown as 1,
      inboundThreshold: '5,ctl:ruleEngine=Off' as unknown as number,
      outboundThreshold: Infinity,
      anomalyAction: 'block' as const,
    };
    expect(crsTuningDirectives(hostile)).toEqual({ beforeRules: [], afterRules: [], ruleIds: [] });
  });
});

describe('buildWafHandler with tuning', () => {
  it('generates exactly the untuned directives when nothing is tuned', () => {
    expect(directivesOf(crsWaf).slice(0, 5)).toEqual([
      'Include @coraza.conf-recommended',
      'Include @crs-setup.conf.example',
      RAW_BODY_RULE,
      'Include @owasp_crs/*.conf',
      'SecRuleEngine On',
    ]);
  });

  it('reads bodies of other content types raw (not as form data), only with the CRS, and reserves the rule id', () => {
    const lines = directivesOf(crsWaf);
    const at = (line: string) => lines.indexOf(line);
    expect(at(RAW_BODY_RULE)).toBeGreaterThan(at('Include @crs-setup.conf.example'));
    expect(at(RAW_BODY_RULE)).toBeLessThan(at('Include @owasp_crs/*.conf'));
    // The same condition as CRS rule 901340: form, multipart, XML and JSON keep their parsers.
    expect(RAW_BODY_RULE).toContain('"!@rx (?:URLENCODED|MULTIPART|XML|JSON)"');
    expect(RAW_BODY_RULE).toContain('ctl:requestBodyProcessor=RAW');
    expect(directivesOf({ ...crsWaf, load_owasp_crs: false })).not.toContain(RAW_BODY_RULE);
    // A custom rule cannot take its id.
    const custom = directivesOf({ ...crsWaf, custom_directives: `SecRule ARGS "@contains x" "id:${RAW_BODY_RULE_ID},deny"` });
    expect(custom.filter((line) => line.includes('"@contains x"'))).toEqual([]);
  });

  it('places tuning and runtime exclusions between the setup and the rules, and updates after the rules', () => {
    const lines = directivesOf(
      { ...crsWaf, paranoia_level: 2, anomaly_action: 'log', excluded_rule_ids: [920350] },
      [
        { id: 7, ruleId: 942100, pathMatch: 'prefix', path: '/wiki/', variable: 'ARGS:content' },
        { id: 8, ruleId: 913100, pathMatch: null, path: null, variable: null },
      ]
    );
    const at = (prefix: string) => lines.findIndex((line) => line.startsWith(prefix));
    expect(at('Include @crs-setup.conf.example')).toBeLessThan(at('SecAction "id:900000'));
    expect(at('SecAction "id:900000')).toBeLessThan(at('SecRule REQUEST_FILENAME'));
    expect(at('SecRule REQUEST_FILENAME')).toBeLessThan(at('Include @owasp_crs/*.conf'));
    expect(at('Include @owasp_crs/*.conf')).toBeLessThan(at('SecRuleUpdateActionById 949110'));
    // Updating a removed rule would fail the whole config: updates come first.
    expect(at('SecRuleUpdateActionById 959101')).toBeLessThan(at('SecRuleRemoveById'));
    expect(lines).toContain('SecRuleRemoveById 913100 920350');
    expect(at('SecRuleRemoveById')).toBeLessThan(at('SecRuleEngine'));
  });

  it('writes no tuning without the Core Rule Set (its variables and rules do not exist)', () => {
    const lines = directivesOf({ ...crsWaf, load_owasp_crs: false, paranoia_level: 3, anomaly_action: 'log' });
    expect(lines.some((line) => /90000[01]|900110|SecRuleUpdateActionById/.test(line))).toBe(false);
  });

  it('still writes runtime exclusions without the Core Rule Set, before the custom rules', () => {
    const lines = directivesOf(
      { ...crsWaf, load_owasp_crs: false, custom_directives: 'SecRule ARGS "@contains x" "id:9001,deny"' },
      [{ id: 3, ruleId: 9001, pathMatch: 'exact', path: '/upload', variable: null }]
    );
    const exclusion = lines.findIndex((line) => line.includes('ctl:ruleRemoveById=9001'));
    expect(exclusion).toBeGreaterThanOrEqual(0);
    expect(exclusion).toBeLessThan(lines.findIndex((line) => line.includes('id:9001,deny')));
  });

  it('drops a custom rule reusing an id the tuning or an exclusion takes, and only then', () => {
    const custom = 'SecRule ARGS "@contains a" "id:900000,deny"\nSecRule ARGS "@contains b" "id:1900000004,deny"';
    const tuned = directivesOf({ ...crsWaf, paranoia_level: 2, custom_directives: custom }, [
      { id: 4, ruleId: 942100, pathMatch: null, path: null, variable: 'ARGS:q' },
    ]);
    expect(tuned.filter((line) => line.includes('"@contains'))).toEqual([]);
    const untuned = directivesOf({ ...crsWaf, custom_directives: custom });
    expect(untuned.filter((line) => line.includes('"@contains'))).toHaveLength(2);
    const { dropped } = filterCustomDirectives(custom, { reservedRuleIds: new Set([900000]) });
    expect(dropped[0].reason).toMatch(/used by the WAF settings/);
  });

  it('lists a custom rule the tuning shadows among the dropped directives', () => {
    const reports = listDroppedWafDirectives(
      { ...crsWaf, paranoia_level: 2, custom_directives: 'SecRule ARGS "@contains a" "id:900000,deny"' },
      []
    );
    expect(reports).toHaveLength(1);
  });

  it('warns about stored exclusions that no longer validate and leaves them out', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lines = directivesOf(crsWaf, [
      { id: 5, ruleId: 942100, pathMatch: 'exact', path: '/a" "id:1,phase:1,pass,ctl:ruleEngine=Off', variable: null },
      { id: 6, ruleId: 942100, pathMatch: null, path: null, variable: 'ARGS:/.*/' },
    ]);
    expect(lines.join('\n')).not.toMatch(/ruleEngine|ARGS:\/|id:1,/);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/2 stored rule exclusion\(s\) are invalid/));
    warn.mockRestore();
  });
});

describe('tuning per host', () => {
  const global: WafSettings = { ...crsWaf, enabled: false, paranoia_level: 3, inbound_anomaly_threshold: 20 };

  it('gives a merging host the global tuning', () => {
    const waf = resolveEffectiveWaf(global, { enabled: true, waf_mode: 'merge' })!;
    expect(resolveWafTuning(waf)).toMatchObject({ paranoiaLevel: 3, inboundThreshold: 20 });
    expect(directivesOf(waf)).toContain('SecAction "id:900000,phase:1,pass,t:none,nolog,setvar:tx.blocking_paranoia_level=3"');
  });

  it('gives a host that overrides the global settings the CRS defaults', () => {
    const waf = resolveEffectiveWaf(global, { enabled: true, waf_mode: 'override', load_owasp_crs: true })!;
    expect(resolveWafTuning(waf)).toEqual(DEFAULT_WAF_TUNING);
  });

  it('applies a host detection-only mode', () => {
    const waf = resolveEffectiveWaf({ ...global, enabled: true }, { enabled: true, mode: 'DetectionOnly' })!;
    expect(directivesOf(waf)).toContain('SecRuleEngine DetectionOnly');
  });
});

describe('wafExclusionsForHost', () => {
  const rows = [
    { id: 1, ruleId: 1001, proxyHostId: null, pathMatch: null, path: null, variable: null },
    { id: 2, ruleId: 1002, proxyHostId: 7, pathMatch: null, path: null, variable: null },
    { id: 3, ruleId: 1003, proxyHostId: 8, pathMatch: null, path: null, variable: null },
  ];

  it('gives a host the global exclusions and its own', () => {
    expect(wafExclusionsForHost(rows, 7, { enabled: true, waf_mode: 'merge' }).map((row) => row.id)).toEqual([1, 2]);
    expect(wafExclusionsForHost(rows, 7, null).map((row) => row.id)).toEqual([1, 2]);
  });

  it('gives a host that overrides the global settings only its own', () => {
    expect(wafExclusionsForHost(rows, 7, { enabled: true, waf_mode: 'override' }).map((row) => row.id)).toEqual([2]);
  });
});
