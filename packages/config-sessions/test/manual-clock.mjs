export class ManualClock {
  time = 1000;
  tasks = new Map();
  callbacks = [];
  cancelled = [];
  now = () => this.time;

  setTimeout(fn, ms) {
    const id = this.callbacks.length;
    this.callbacks.push(fn);
    this.tasks.set(id, { fn, ms });
    return id;
  }

  clearTimeout(id) {
    this.cancelled.push(id);
    this.tasks.delete(id);
  }

  fire(id = this.callbacks.length - 1) {
    this.tasks.delete(id);
    this.callbacks[id]();
  }

  get delay() {
    return [...this.tasks.values()].at(-1)?.ms;
  }
}
