export function renderProducts(list: Element, products: ReadonlyArray<{ id: number; name: string; price: number }>): void {
  list.innerHTML = products.map((p) => `<li><a href="/products/${p.id}">${p.name}</a> <span>$${p.price}</span></li>`).join('');
}
