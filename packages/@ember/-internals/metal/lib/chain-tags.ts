import { meta as metaFor, peekMeta } from '@ember/-internals/meta';
import { isEmberArray } from '@ember/-internals/utils';
import { assert } from '@ember/debug';
import { combine, CONSTANT_TAG, Tag, UpdatableTag } from '@glimmer/reference';
import { getLastRevisionFor, peekCacheFor } from './computed_cache';
import { descriptorForProperty } from './descriptor_map';
import get from './property_get';
import { tagForProperty } from './tags';
import { untrack } from './tracked';

export function finishLazyChains(obj: any, key: string, value: any) {
  let meta = peekMeta(obj);
  let lazyTags = meta !== null ? meta.readableLazyChainsFor(key) : undefined;

  if (lazyTags === undefined) {
    return;
  }

  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    for (let path in lazyTags) {
      delete lazyTags[path];
    }
    return;
  }

  for (let path in lazyTags) {
    let tag = lazyTags[path];

    tag.inner.update(combine(getChainTagsForKey(value, path)));

    delete lazyTags[path];
  }
}

export function getChainTagsForKeys(obj: any, keys: string[]) {
  let chainTags: Tag[] = [];

  for (let i = 0; i < keys.length; i++) {
    chainTags.push(...getChainTagsForKey(obj, keys[i]));
  }

  return chainTags;
}

export function getChainTagsForKey(obj: any, path: string) {
  let chainTags: Tag[] = [];

  let current: any = obj;

  let segmentEnd = -1;
  // prevent closures
  let segment: string, descriptor: any;

  while (true) {
    let lastSegmentEnd = segmentEnd + 1;
    segmentEnd = path.indexOf('.', lastSegmentEnd);

    if (segmentEnd === -1) {
      segmentEnd = path.length;
    }

    segment = path.slice(lastSegmentEnd, segmentEnd);

    if (segment === '@each' && segmentEnd !== path.length) {
      assert(
        `When using @each, the value you are attempting to watch must be an array, was: ${current.toString()}`,
        Array.isArray(current) || isEmberArray(current)
      );

      segment = path.substr(segmentEnd + 1)!;

      // There shouldn't be any more segments after an `@each`, so break
      assert(
        `When using @each, you can only chain one property level deep`,
        segment.indexOf('.') === -1
      );

      // Push the tags for each item's property
      let tags = (current as Array<any>).map(item => {
        assert(
          `When using @each to observe the array \`${current.toString()}\`, the items in the array must be objects`,
          typeof item === 'object'
        );

        return tagForProperty(item, segment);
      });

      // Push the tag for the array length itself
      chainTags.push(...tags, tagForProperty(current, '[]'));

      break;
    }

    let propertyTag = tagForProperty(current, segment);

    chainTags.push(propertyTag);

    if (segmentEnd === path.length) {
      break;
    }

    descriptor = descriptorForProperty(current, segment);

    if (descriptor === undefined) {
      // TODO: Assert that current[segment] isn't an undecorated, non-MANDATORY_SETTER getter

      if (!(segment in current) && typeof current.unknownProperty === 'function') {
        current = current.unknownProperty(segment);
      } else {
        current = current[segment];
      }
    } else {
      let lastRevision = getLastRevisionFor(current, segment);

      if (propertyTag.validate(lastRevision)) {
        if (typeof descriptor.altKey === 'string') {
          // it's an alias, so just get the altkey without tracking
          untrack(() => {
            current = get(current, descriptor.altKey);
          });
        } else {
          current = peekCacheFor(current).get(segment);
        }
      } else {
        let lazyChains = metaFor(current).writableLazyChainsFor(segment);

        let rest = path.substr(segmentEnd + 1);

        let placeholderTag = lazyChains[rest];

        if (placeholderTag === undefined) {
          placeholderTag = lazyChains[rest] = UpdatableTag.create(CONSTANT_TAG);
        }

        chainTags.push(placeholderTag);

        break;
      }
    }

    let currentType = typeof current;

    if (current === null || (currentType !== 'object' && currentType !== 'function')) {
      // we've hit the end of the chain for now, break out
      break;
    }
  }

  return chainTags;
}
