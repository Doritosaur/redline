// Known problems, on purpose. Each one should show up in a Redline report.
import _ from 'lodash'; // whole library for one helper -> unused JavaScript
import { startAnalytics } from './analytics.js';
import { renderProducts } from './products.js';

interface Product {
  id: number;
  name: string;
  price: number;
}

const products: Product[] = [
  { id: 3, name: 'Lamp', price: 40 },
  { id: 1, name: 'Chair', price: 120 },
  { id: 2, name: 'Desk', price: 300 },
];

// Modern APIs without fallbacks -> compatibility findings for older Safari/Firefox.
const sorted = products.toSorted((a, b) => a.price - b.price);
const snapshot = structuredClone(sorted);
renderProducts(document.querySelector('#products')!, _.sortBy(snapshot, 'name'));

// Late-inserted banner with no reserved space -> layout shift.
setTimeout(() => {
  const banner = document.createElement('div');
  banner.className = 'promo';
  banner.textContent = 'Free shipping this week!';
  document.body.prepend(banner);
}, 1200);

// Slow click handler -> poor INP.
document.querySelector('#add-to-cart')?.addEventListener('click', () => {
  const end = performance.now() + 350;
  while (performance.now() < end) {
    // simulate expensive cart recalculation
  }
  document.querySelector('#cart-count')!.textContent = String(Number(document.querySelector('#cart-count')!.textContent) + 1);
});

document.querySelector('#share')?.addEventListener('click', () => navigator.share?.({ url: location.href }));

startAnalytics();
