// ==UserScript==
// @name         FetLife Most Comments and Most love
// @namespace    https://fetlife.com/
// @version      2.0.0
// @description  Adds Most Comments and Most love filters that scan multiple paginated pages of FetLife group discussions.
// @match        https://fetlife.com/groups/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const FRAME_SELECTOR = '#group-discussions';
  const RESULTS_SELECTOR = '#group-discussions-results';
  const ARTICLE_SELECTOR = 'article[id^="story_group_post_"]';
  const ITEM_ATTRIBUTE = 'data-fetlife-popular-sort';
  const options = [
    { key: 'comments', label: 'Most Comments' },
    { key: 'love', label: 'Most love' }
  ];

  const MAX_PAGES_KEY = 'fetlife-popular-max-pages';
  const CONCURRENCY = 3;
  const DELAY_MS = 400;
  const SHOW_LIMIT = 100;
  const cache = new Map();
  let scanToken = 0;
  let activeSort = null;
  let updateQueued = false;

  function getCount(article, sortKey) {
    if (sortKey === 'love') {
      const value = article.querySelector(
        '[data-story-love-button-loves-count-value]'
      )?.getAttribute('data-story-love-button-loves-count-value');
      return Number.parseInt(value || '0', 10) || 0;
    }

    const value = article.querySelector('[data-comment-cta-count]')?.textContent;
    return Number.parseInt((value || '0').replace(/[^\d-]/g, ''), 10) || 0;
  }

  function sortArticles(sortKey) {
    const articles = Array.from(
      document.querySelectorAll(`${RESULTS_SELECTOR} ${ARTICLE_SELECTOR}`)
    );
    const groups = new Map();

    for (const article of articles) {
      const parent = article.parentElement;
      if (!parent) continue;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(article);
    }

    for (const [parent, group] of groups) {
      const sorted = group
        .map((article, index) => ({ article, index, count: getCount(article, sortKey) }))
        .sort((a, b) => b.count - a.count || a.index - b.index)
        .map(({ article }) => article);

      if (sorted.some((article, index) => article !== group[index])) {
        parent.append(...sorted);
      }
    }
  }

  function updateTriggerLabel(trigger, label) {
    const labelContainer = trigger.querySelector('span.flex.items-center');
    if (labelContainer?.firstChild?.nodeType === Node.TEXT_NODE) {
      labelContainer.firstChild.textContent = `${label} `;
    }

    trigger.title = label;
    trigger.setAttribute('aria-label', label);
  }

  function getLastPage(root) {
    let last = 1;
    for (const link of root.querySelectorAll('.pagination a[href*="page="]')) {
      const page = Number.parseInt(
        new URL(link.getAttribute('href'), location.origin).searchParams.get('page'),
        10
      );
      if (page > last) last = page;
    }
    return last;
  }

  function pageUrl(page) {
    const url = new URL(location.href);
    url.searchParams.set('page', String(page));
    return url.toString();
  }

  function getStatus() {
    let status = document.getElementById('fetlife-popular-status');
    if (!status) {
      status = document.createElement('div');
      status.id = 'fetlife-popular-status';
      status.style.cssText = 'padding:8px 12px;margin:8px 0;border:1px solid #888;border-radius:6px;font-size:14px;display:flex;gap:12px;align-items:center;';
      document.querySelector(RESULTS_SELECTOR)?.before(status);
    }
    return status;
  }

  function setStatus(text, buttons = []) {
    const status = getStatus();
    status.textContent = text;
    for (const [label, handler] of buttons) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.style.cssText = 'text-decoration:underline;cursor:pointer;';
      button.addEventListener('click', handler);
      status.append(button);
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function scanPages(maxPages, token) {
    const key = location.pathname + new URLSearchParams(
      [...new URLSearchParams(location.search)].filter(([name]) => name !== 'page')
    );
    let entry = cache.get(key);
    if (!entry) {
      entry = { articles: new Map(), done: new Set([1]), total: getLastPage(document) };
      for (const article of document.querySelectorAll(`${RESULTS_SELECTOR} ${ARTICLE_SELECTOR}`)) {
        entry.articles.set(article.id, article.cloneNode(true));
      }
      cache.set(key, entry);
    }

    const last = Math.min(entry.total, maxPages);
    const pending = [];
    for (let page = 2; page <= last; page++) {
      if (!entry.done.has(page)) pending.push(page);
    }

    const cancel = () => { scanToken++; };
    let completed = 0;
    const worker = async () => {
      while (pending.length && token === scanToken) {
        const page = pending.shift();
        try {
          const response = await fetch(pageUrl(page), { credentials: 'same-origin' });
          if (response.ok) {
            const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
            for (const article of doc.querySelectorAll(`${RESULTS_SELECTOR} ${ARTICLE_SELECTOR}`)) {
              if (!entry.articles.has(article.id)) entry.articles.set(article.id, article);
            }
            entry.done.add(page);
          }
        } catch (error) {
          console.warn('FetLife popular filters: page failed', page, error);
        }
        completed++;
        if (token === scanToken) {
          setStatus(`Scanning page ${completed} of ${last - 1}... (${entry.articles.size} posts)`, [['Cancel', cancel]]);
        }
        await sleep(DELAY_MS);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return { entry, cancelled: token !== scanToken, scanned: entry.done.size };
  }

  function render(entry, sortKey) {
    const results = document.querySelector(RESULTS_SELECTOR);
    const first = results?.querySelector(ARTICLE_SELECTOR);
    const parent = first?.parentElement;
    if (!parent) return;

    const sorted = Array.from(entry.articles.values())
      .map((article, index) => ({ article, index, count: getCount(article, sortKey) }))
      .sort((a, b) => b.count - a.count || a.index - b.index)
      .slice(0, SHOW_LIMIT)
      .map(({ article }) => document.importNode(article, true));

    for (const old of results.querySelectorAll(ARTICLE_SELECTOR)) old.remove();
    parent.append(...sorted);
    document.querySelectorAll('.pagination').forEach((p) => { p.style.display = 'none'; });
  }

  async function scanAndSort(sortKey) {
    const token = ++scanToken;
    let maxPages = Number.parseInt(localStorage.getItem(MAX_PAGES_KEY) || '20', 10);
    const answer = window.prompt(
      `How many pages should be scanned? (this group has ${getLastPage(document)} pages; each page is one request)`,
      String(maxPages)
    );
    if (answer === null) return;
    maxPages = Math.max(1, Number.parseInt(answer, 10) || maxPages);
    localStorage.setItem(MAX_PAGES_KEY, String(maxPages));

    const { entry, cancelled, scanned } = await scanPages(maxPages, token);
    if (token !== scanToken && !cancelled) return;
    render(entry, sortKey);
    setStatus(
      `${cancelled ? 'Scan cancelled. ' : ''}Showing top ${Math.min(SHOW_LIMIT, entry.articles.size)} of ${entry.articles.size} posts from ${scanned} page(s), sorted by ${sortKey === 'love' ? 'most love' : 'most comments'}.`,
      [['Restore normal view', () => location.reload()]]
    );
  }

  function selectSort(sortKey, trigger, menu) {
    activeSort = sortKey;
    scanAndSort(sortKey);

    const selected = options.find((option) => option.key === sortKey);
    if (selected) updateTriggerLabel(trigger, selected.label);

    for (const option of options) {
      const item = menu.querySelector(`[${ITEM_ATTRIBUTE}="${option.key}"]`);
      if (option.key === sortKey) {
        item?.setAttribute('aria-current', 'true');
      } else {
        item?.removeAttribute('aria-current');
      }
    }

    trigger.click();
  }

  function addSortOptions() {
    const frame = document.querySelector(FRAME_SELECTOR);
    const menu = frame?.querySelector('[data-dropdown-target="menu"]');
    const trigger = frame?.querySelector('[data-dropdown-target="trigger"]');
    const itemContainer = menu?.querySelector('.max-w-lg');
    if (!menu || !trigger || !itemContainer) return;

    for (const option of options) {
      if (menu.querySelector(`[${ITEM_ATTRIBUTE}="${option.key}"]`)) continue;

      const item = document.createElement('a');
      item.href = '#';
      item.className = 'dropdown-menu-entry group/entry';
      item.setAttribute(ITEM_ATTRIBUTE, option.key);
      item.title = 'Scan multiple pages and sort all scanned posts';
      item.innerHTML = `<span class="flex min-w-0 flex-auto items-center gap-2.5">${option.label}</span>`;
      item.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectSort(option.key, trigger, menu);
      });
      itemContainer.append(item);
    }

    if (activeSort) {
      const selected = options.find((option) => option.key === activeSort);
      if (selected) updateTriggerLabel(trigger, selected.label);
      menu.querySelector(`[${ITEM_ATTRIBUTE}="${activeSort}"]`)
        ?.setAttribute('aria-current', 'true');
    }
  }

  function update() {
    updateQueued = false;
    addSortOptions();
    if (activeSort) sortArticles(activeSort);
  }

  function queueUpdate() {
    if (updateQueued) return;
    updateQueued = true;
    window.requestAnimationFrame(update);
  }

  document.addEventListener('turbo:load', queueUpdate);
  document.addEventListener('turbo:frame-load', queueUpdate);
  document.addEventListener('DOMContentLoaded', queueUpdate);

  const observer = new MutationObserver(queueUpdate);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  queueUpdate();
})();
