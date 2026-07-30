import { Box3, Vector3 } from 'three';
import { Octree } from 'three/examples/jsm/math/Octree.js';

// ---------------------------------------------------------------------------
// three's Octree is a good capsule-collision structure but it cannot be tuned:
// `split()` builds its children with `new Octree(box)`, so every subnode resets
// to the stock `maxLevel = 16` / `trianglesPerLeaf = 8` no matter what you set
// on the root.
//
// That matters here because `split()` copies each triangle into *every* subnode
// whose box it overlaps. Over a 300m level, depth 16 means ~5mm leaf cells, so
// a single 2m ground quad is duplicated into hundreds of thousands of nodes.
// Building the level's 79k collidable triangles that way exhausts the heap and
// crashes the tab before the first frame.
//
// This subclass reimplements `split()` so children inherit the tuning. Depth 8
// over 300m gives ~1.2m leaves, which is the right order for a 0.34m-radius
// player capsule, and a larger leaf bucket stops subdivision before duplication
// dominates.
// ---------------------------------------------------------------------------

const _v1 = new Vector3();
const _v2 = new Vector3();

export class CollisionOctree extends Octree {
  constructor(box, maxLevel = 8, trianglesPerLeaf = 24) {
    super(box);
    this.maxLevel = maxLevel;
    this.trianglesPerLeaf = trianglesPerLeaf;
  }

  split(level) {
    if (!this.box) return;

    const subTrees = [];
    const halfsize = _v2.copy(this.box.max).sub(this.box.min).multiplyScalar(0.5);

    for (let x = 0; x < 2; x++) {
      for (let y = 0; y < 2; y++) {
        for (let z = 0; z < 2; z++) {
          const box = new Box3();
          const v = _v1.set(x, y, z);
          box.min.copy(this.box.min).add(v.multiply(halfsize));
          box.max.copy(box.min).add(halfsize);
          // The one line that differs from three: children keep the tuning.
          subTrees.push(new CollisionOctree(box, this.maxLevel, this.trianglesPerLeaf));
        }
      }
    }

    let triangle;
    while ((triangle = this.triangles.pop())) {
      for (let i = 0; i < subTrees.length; i++) {
        if (subTrees[i].box.intersectsTriangle(triangle)) {
          subTrees[i].triangles.push(triangle);
        }
      }
    }

    for (let i = 0; i < subTrees.length; i++) {
      const len = subTrees[i].triangles.length;
      if (len > this.trianglesPerLeaf && level < this.maxLevel) {
        subTrees[i].split(level + 1);
      }
      if (len !== 0) this.subTrees.push(subTrees[i]);
    }

    return this;
  }

  /** Node and triangle-reference counts, for budgeting. */
  stats() {
    let nodes = 0, refs = 0, maxDepth = 0;
    const walk = (n, d) => {
      nodes++;
      refs += n.triangles.length;
      if (d > maxDepth) maxDepth = d;
      for (const s of n.subTrees) walk(s, d + 1);
    };
    walk(this, 0);
    return { nodes, refs, maxDepth };
  }
}
