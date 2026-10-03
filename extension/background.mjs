chrome.action.onClicked.addListener(async (tab) => {
  if (!Number.isInteger(tab.id)) return;
  const url = new URL(chrome.runtime.getURL('workbench.html'));
  url.searchParams.set('sourceTab', String(tab.id));
  try {
    const source = new URL(tab.url);
    url.searchParams.set('source', source.origin + source.pathname);
    url.searchParams.set('title', String(tab.title || '当前页面').slice(0, 1000));
  } catch { /* Workbench will ask for a supported source page. */ }
  await chrome.tabs.create({ url: url.href });
});
