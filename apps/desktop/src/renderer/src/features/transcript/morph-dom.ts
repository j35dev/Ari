function syncAttributes(current: Element, next: Element): void {
  for (const name of current.getAttributeNames()) {
    if (!next.hasAttribute(name)) current.removeAttribute(name)
  }
  for (const name of next.getAttributeNames()) {
    const value = next.getAttribute(name) ?? ''
    if (current.getAttribute(name) !== value) current.setAttribute(name, value)
  }
}

function morphChildren(current: Element, next: Element): void {
  let mine = current.firstChild
  let theirs = next.firstChild
  while (theirs !== null) {
    // Read both siblings first: adopting `theirs` moves it out of `next`.
    const theirsAfter = theirs.nextSibling
    if (mine === null) {
      current.appendChild(theirs)
    } else {
      const mineAfter: ChildNode | null = mine.nextSibling
      if (!morphNode(mine, theirs)) current.replaceChild(theirs, mine)
      mine = mineAfter
    }
    theirs = theirsAfter
  }
  while (mine !== null) {
    const after: ChildNode | null = mine.nextSibling
    mine.remove()
    mine = after
  }
}

/**
 * Updates `current` in place to match `next`, touching only what differs, and
 * returns false when the two are different kinds of node and the caller has to
 * swap them instead. `next` is consumed: nodes with no counterpart are moved
 * out of it rather than copied.
 *
 * Streaming appends to the end of a block, so a morph leaves every node before
 * the new text alone. That is what keeps a selection, a running entrance
 * animation and already-highlighted code intact while the block grows, where
 * replacing its markup rebuilt all of it on every flush.
 */
export function morphNode(current: Node, next: Node): boolean {
  if (current.nodeType !== next.nodeType) return false
  if (!(current instanceof Element) || !(next instanceof Element)) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue
    return true
  }
  if (current.tagName !== next.tagName) return false
  syncAttributes(current, next)
  morphChildren(current, next)
  return true
}
