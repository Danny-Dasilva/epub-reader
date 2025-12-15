/**
 * Min-Heap implementation for priority queue
 * Optimization #2: O(log n) insertion and O(1) peek instead of O(n log n) sort
 */
export class MinHeap<T> {
  private heap: T[] = [];
  private compare: (a: T, b: T) => number;

  /**
   * @param compare Comparison function that returns negative if a < b, positive if a > b, 0 if equal
   */
  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare;
  }

  get size(): number {
    return this.heap.length;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /**
   * Peek at the minimum element without removing it - O(1)
   */
  peek(): T | undefined {
    return this.heap[0];
  }

  /**
   * Insert an element - O(log n)
   */
  push(item: T): void {
    this.heap.push(item);
    this.bubbleUp(this.heap.length - 1);
  }

  /**
   * Remove and return the minimum element - O(log n)
   */
  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    if (this.heap.length === 1) return this.heap.pop();

    const min = this.heap[0];
    this.heap[0] = this.heap.pop()!;
    this.bubbleDown(0);
    return min;
  }

  /**
   * Remove an item by predicate - O(n)
   * Returns true if item was found and removed
   */
  remove(predicate: (item: T) => boolean): boolean {
    const index = this.heap.findIndex(predicate);
    if (index === -1) return false;

    if (index === this.heap.length - 1) {
      this.heap.pop();
      return true;
    }

    this.heap[index] = this.heap.pop()!;
    // Could bubble up or down depending on the replacement
    this.bubbleUp(index);
    this.bubbleDown(index);
    return true;
  }

  /**
   * Find an item by predicate - O(n)
   */
  find(predicate: (item: T) => boolean): T | undefined {
    return this.heap.find(predicate);
  }

  /**
   * Check if an item exists - O(n)
   */
  some(predicate: (item: T) => boolean): boolean {
    return this.heap.some(predicate);
  }

  /**
   * Get all items as array (no guaranteed order) - O(n)
   */
  toArray(): T[] {
    return [...this.heap];
  }

  /**
   * Clear all items - O(1)
   */
  clear(): void {
    this.heap = [];
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.compare(this.heap[index], this.heap[parentIndex]) >= 0) break;
      this.swap(index, parentIndex);
      index = parentIndex;
    }
  }

  private bubbleDown(index: number): void {
    const length = this.heap.length;
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let smallest = index;

      if (leftChild < length && this.compare(this.heap[leftChild], this.heap[smallest]) < 0) {
        smallest = leftChild;
      }
      if (rightChild < length && this.compare(this.heap[rightChild], this.heap[smallest]) < 0) {
        smallest = rightChild;
      }
      if (smallest === index) break;

      this.swap(index, smallest);
      index = smallest;
    }
  }

  private swap(i: number, j: number): void {
    [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
  }
}
