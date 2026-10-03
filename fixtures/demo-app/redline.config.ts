export default {
  baseUrl: 'http://localhost:4321',
  pages: ['/'],
  sitemap: '/sitemap.xml',
  perTemplate: 1,
  runs: 1,
  budgets: { score: 80, lcp: 2500, cls: 0.1, tbt: 300 },
  flows: [{ name: 'Add to cart', url: '/', steps: [{ wait: 1000 }, { click: '#add-to-cart' }, { click: '#add-to-cart' }] }],
};
