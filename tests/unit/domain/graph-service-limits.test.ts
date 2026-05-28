import { describe, it, expect } from 'vitest';
import { GRAPH_SERVICE_LIMITS } from '@/domain/graph-service-limits-values';

describe('GRAPH_SERVICE_LIMITS', () => {
  describe('outlook pool', () => {
    const limits = GRAPH_SERVICE_LIMITS.outlook;

    it('has the correct pool and scope identifiers', () => {
      expect(limits.pool).toBe('outlook');
      expect(limits.scope).toBe('per_app_per_mailbox');
      expect(limits.cost_model).toBe('flat');
    });

    it('enforces 10,000 requests per 10-minute window', () => {
      expect(limits.requests_per_window).toBe(10_000);
      expect(limits.window_duration_ms).toBe(10 * 60 * 1_000);
    });

    it('enforces 4 concurrent requests', () => {
      expect(limits.max_concurrent_requests).toBe(4);
    });

    it('enforces 150 MB upload per 5-minute window', () => {
      expect(limits.upload_bytes_per_window).toBe(150 * 1024 * 1024);
      expect(limits.upload_window_duration_ms).toBe(5 * 60 * 1_000);
    });

    it('is frozen (immutable)', () => {
      expect(Object.isFrozen(limits)).toBe(true);
    });
  });

  describe('sharepoint_onedrive pool', () => {
    const limits = GRAPH_SERVICE_LIMITS.sharepoint_onedrive;

    it('has the correct pool and scope identifiers', () => {
      expect(limits.pool).toBe('sharepoint_onedrive');
      expect(limits.scope).toBe('per_app_per_tenant');
      expect(limits.cost_model).toBe('resource_units');
    });

    it('has correct resource unit limits for smallest tenant tier', () => {
      expect(limits.resource_units_per_minute['0-1000']).toBe(1_250);
      expect(limits.resource_units_per_day['0-1000']).toBe(1_200_000);
    });

    it('has correct resource unit limits for largest tenant tier', () => {
      expect(limits.resource_units_per_minute['50000+']).toBe(6_250);
      expect(limits.resource_units_per_day['50000+']).toBe(6_000_000);
    });

    it('has correct delta token cost values', () => {
      expect(limits.delta_with_token_cost).toBe(1);
      expect(limits.delta_without_token_cost).toBe(2);
    });

    it('has a safe default cost estimate of 2 RU/request', () => {
      expect(limits.default_cost_per_request).toBe(2);
    });

    it('is frozen (immutable)', () => {
      expect(Object.isFrozen(limits)).toBe(true);
    });
  });

  describe('identity pool', () => {
    const limits = GRAPH_SERVICE_LIMITS.identity;

    it('has the correct pool and scope identifiers', () => {
      expect(limits.pool).toBe('identity');
      expect(limits.scope).toBe('per_app_per_tenant');
      expect(limits.cost_model).toBe('resource_units');
    });

    it('has correct per-tenant limits by tenant size tier', () => {
      expect(limits.resource_units_per_10s['S']).toBe(3_500);
      expect(limits.resource_units_per_10s['M']).toBe(5_000);
      expect(limits.resource_units_per_10s['L']).toBe(8_000);
    });

    it('has correct global per-app limit', () => {
      expect(limits.resource_units_per_20s_global).toBe(150_000);
    });

    it('has correct GET /users base cost', () => {
      expect(limits.users_list_cost).toBe(2);
    });

    it('has correct GET /users/{id} base cost', () => {
      expect(limits.user_get_cost).toBe(1);
    });

    it('is frozen (immutable)', () => {
      expect(Object.isFrozen(limits)).toBe(true);
    });
  });

  it('the outer object is frozen', () => {
    expect(Object.isFrozen(GRAPH_SERVICE_LIMITS)).toBe(true);
  });
});
