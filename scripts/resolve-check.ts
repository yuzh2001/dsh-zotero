/* Throwaway test: exercise the enriched resolveByKey against the live Zotero DB. */
import { ZoteroHost } from '../src/host/zotero.js'

async function main(): Promise<void> {
  const host = new ZoteroHost()
  try {
    // Force a full load so itemsByKey is warm.
    await host.libraryTree()
    const found = await host.search('the', 400)
    let target: { key: string; title: string } | undefined
    for (const r of found.results) {
      const d = await host.resolveByKey(r.key)
      if (d && d.attachments.some((a) => a.isPDF)) { target = { key: r.key, title: d.title }; break }
    }
    if (!target) { console.log('no PDF-attachment item found among search results'); return }
    console.log('Resolving:', target.title, target.key)
    const resolved = await host.resolveByKey(target.key)
    console.log(JSON.stringify(resolved, null, 2))
  } finally {
    host.close()
  }
}

void main()

