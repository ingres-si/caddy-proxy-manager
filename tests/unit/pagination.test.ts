/**
 * Paging for dashboard lists (src/lib/pagination.ts) and the pager
 * (src/components/ui/Pagination.tsx).
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_PAGE_SIZE, pageNumbers, paginate, parsePageParam } from '@/src/lib/pagination';
import { textContent } from '../helpers/text';

vi.mock('next/navigation', () => ({ usePathname: () => '/x', useSearchParams: () => new URLSearchParams('') }));
const { Pagination } = await import('@/src/components/ui/Pagination');

describe('paginate', () => {
  const rows = Array.from({ length: 53 }, (_, i) => i + 1);

  it('slices the page and says which rows it holds', () => {
    expect(paginate(rows, 2)).toMatchObject({ page: 2, pageCount: 3, total: 53, perPage: DEFAULT_PAGE_SIZE, from: 26, to: 50 });
    expect(paginate(rows, 2).items).toEqual(rows.slice(25, 50));
    expect(paginate(rows, 3).items).toEqual([51, 52, 53]);
  });

  it('clamps a page past the end or below 1, and keeps one empty page for no rows', () => {
    expect(paginate(rows, 9).page).toBe(3);
    expect(paginate(rows, 0).page).toBe(1);
    expect(paginate([], 4)).toMatchObject({ page: 1, pageCount: 1, items: [], from: 0, to: 0 });
  });
});

describe('parsePageParam', () => {
  it('reads positive integers only', () => {
    expect(parsePageParam('3')).toBe(3);
    expect(parsePageParam(['2', '5'])).toBe(2);
    for (const bad of [null, undefined, '', '0', '-1', '1.5', 'abc', '9999999']) expect(parsePageParam(bad), String(bad)).toBe(1);
  });
});

describe('pageNumbers', () => {
  it('shows the ends, the current page and its neighbours, with gaps', () => {
    expect(pageNumbers(1, 1)).toEqual([1]);
    expect(pageNumbers(1, 5)).toEqual([1, 2, null, 5]);
    expect(pageNumbers(6, 12)).toEqual([1, null, 5, 6, 7, null, 12]);
    expect(pageNumbers(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageNumbers(12, 12)).toEqual([1, null, 11, 12]);
  });
});

describe('Pagination', () => {
  it('renders nothing while everything fits on one page', () => {
    expect(renderToStaticMarkup(createElement(Pagination, { page: 1, perPage: 25, total: 25, hrefFor: (p: number) => `?page=${p}` }))).toBe('');
  });

  it('links every page and marks the current one', () => {
    const html = renderToStaticMarkup(createElement(Pagination, { page: 2, perPage: 25, total: 60, noun: 'hosts', label: 'Pages of hosts', hrefFor: (p: number) => `/x?page=${p}` }));
    expect(html).toContain('aria-label="Pages of hosts"');
    expect(textContent(html)).toContain('26–50 of 60 hosts');
    expect(html).toContain('href="/x?page=1"');
    expect(html).toContain('href="/x?page=3"');
    expect(html).toMatch(/aria-current="page"[^>]*>|aria-label="Page 2"[^>]*aria-current="page"/);
  });
});
