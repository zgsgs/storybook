import memoize from 'memoizerific';
import {
  Parameters,
  StoryId,
  StoryContextForLoaders,
  AnyFramework,
  ProjectAnnotations,
  ComponentTitle,
  StoryContextForEnhancers,
  StoryContext,
} from '@storybook/csf';
import mapValues from 'lodash/mapValues';
import pick from 'lodash/pick';
import global from 'global';
import { SynchronousPromise } from 'synchronous-promise';

import { StoryIndexStore } from './StoryIndexStore';
import { ArgsStore } from './ArgsStore';
import { GlobalsStore } from './GlobalsStore';
import { processCSFFile } from './processCSFFile';
import { prepareStory } from './prepareStory';
import {
  CSFFile,
  ModuleImportFn,
  Story,
  NormalizedProjectAnnotations,
  Path,
  ExtractOptions,
  BoundStory,
  StoryIndex,
  StoryIndexEntry,
  V2CompatIndexEntry,
} from './types';
import { HooksContext } from './hooks';
import { normalizeInputTypes } from './normalizeInputTypes';
import { inferArgTypes } from './inferArgTypes';
import { inferControls } from './inferControls';

// TODO -- what are reasonable values for these?
const CSF_CACHE_SIZE = 1000;
const STORY_CACHE_SIZE = 10000;

function normalizeProjectAnnotations<TFramework extends AnyFramework>({
  argTypes,
  globalTypes,
  argTypesEnhancers,
  ...annotations
}: ProjectAnnotations<TFramework>): NormalizedProjectAnnotations<TFramework> {
  return {
    ...(argTypes && { argTypes: normalizeInputTypes(argTypes) }),
    ...(globalTypes && { globalTypes: normalizeInputTypes(globalTypes) }),
    argTypesEnhancers: [
      ...(argTypesEnhancers || []),
      inferArgTypes,
      // inferControls technically should only run if the user is using the controls addon,
      // and so should be added by a preset there. However, as it seems some code relies on controls
      // annotations (in particular the angular implementation's `cleanArgsDecorator`), for backwards
      // compatibility reasons, we will leave this in the store until 7.0
      inferControls,
    ],
    ...annotations,
  };
}

export class StoryStore<TFramework extends AnyFramework> {
  storyIndex: StoryIndexStore;

  importFn: ModuleImportFn;

  projectAnnotations: NormalizedProjectAnnotations<TFramework>;

  globals: GlobalsStore;

  args: ArgsStore;

  hooks: Record<StoryId, HooksContext<TFramework>>;

  cachedCSFFiles?: Record<Path, CSFFile<TFramework>>;

  processCSFFileWithCache: typeof processCSFFile;

  prepareStoryWithCache: typeof prepareStory;

  initializationPromise: SynchronousPromise<void>;

  resolveInitializationPromise: () => void;

  constructor() {
    this.globals = new GlobalsStore();
    this.args = new ArgsStore();
    this.hooks = {};

    // We use a cache for these two functions for two reasons:
    //  1. For performance
    //  2. To ensure that when the same story is prepared with the same inputs you get the same output
    this.processCSFFileWithCache = memoize(CSF_CACHE_SIZE)(processCSFFile) as typeof processCSFFile;
    this.prepareStoryWithCache = memoize(STORY_CACHE_SIZE)(prepareStory) as typeof prepareStory;

    // We cannot call `loadStory()` until we've been initialized properly. But we can wait for it.
    this.initializationPromise = new SynchronousPromise((resolve) => {
      this.resolveInitializationPromise = resolve;
    });
  }

  setProjectAnnotations(projectAnnotations: ProjectAnnotations<TFramework>) {
    // By changing `this.projectAnnotations, we implicitly invalidate the `prepareStoryWithCache`
    this.projectAnnotations = normalizeProjectAnnotations(projectAnnotations);
    const { globals, globalTypes } = projectAnnotations;

    this.globals.set({ globals, globalTypes });
  }

  initialize({
    storyIndex,
    importFn,
    cache = false,
  }: {
    storyIndex?: StoryIndex;
    importFn: ModuleImportFn;
    cache?: boolean;
  }): PromiseLike<void> {
    this.storyIndex = new StoryIndexStore(storyIndex);
    this.importFn = importFn;

    // We don't need the cache to be loaded to call `loadStory`, we just need the index ready
    this.resolveInitializationPromise();

    return cache ? this.cacheAllCSFFiles() : SynchronousPromise.resolve();
  }

  // This means that one of the CSF files has changed.
  // If the `importFn` has changed, we will invalidate both caches.
  // If the `storyIndex` data has changed, we may or may not invalidate the caches, depending
  // on whether we've loaded the relevant files yet.
  async onStoriesChanged({
    importFn,
    storyIndex,
  }: {
    importFn?: ModuleImportFn;
    storyIndex?: StoryIndex;
  }) {
    if (importFn) this.importFn = importFn;
    if (storyIndex) this.storyIndex.stories = storyIndex.stories;
    if (this.cachedCSFFiles) await this.cacheAllCSFFiles();
  }

  // To load a single CSF file to service a story we need to look up the importPath in the index
  loadCSFFileByStoryId(storyId: StoryId): PromiseLike<CSFFile<TFramework>> {
    const { importPath, title } = this.storyIndex.storyIdToEntry(storyId);
    return this.importFn(importPath).then((moduleExports) =>
      // We pass the title in here as it may have been generated by autoTitle on the server.
      this.processCSFFileWithCache(moduleExports, importPath, title)
    );
  }

  loadAllCSFFiles(): PromiseLike<StoryStore<TFramework>['cachedCSFFiles']> {
    const importPaths: Record<Path, StoryId> = {};
    Object.entries(this.storyIndex.stories).forEach(([storyId, { importPath }]) => {
      importPaths[importPath] = storyId;
    });

    const csfFilePromiseList = Object.entries(importPaths).map(([importPath, storyId]) =>
      this.loadCSFFileByStoryId(storyId).then((csfFile) => ({
        importPath,
        csfFile,
      }))
    );

    return SynchronousPromise.all(csfFilePromiseList).then((list) =>
      list.reduce((acc, { importPath, csfFile }) => {
        acc[importPath] = csfFile;
        return acc;
      }, {} as Record<Path, CSFFile<TFramework>>)
    );
  }

  cacheAllCSFFiles(): PromiseLike<void> {
    return this.initializationPromise.then(() =>
      this.loadAllCSFFiles().then((csfFiles) => {
        this.cachedCSFFiles = csfFiles;
      })
    );
  }

  // Load the CSF file for a story and prepare the story from it and the project annotations.
  async loadStory({ storyId }: { storyId: StoryId }): Promise<Story<TFramework>> {
    await this.initializationPromise;
    const csfFile = await this.loadCSFFileByStoryId(storyId);
    return this.storyFromCSFFile({ storyId, csfFile });
  }

  // This function is synchronous for convenience -- often times if you have a CSF file already
  // it is easier not to have to await `loadStory`.
  storyFromCSFFile({
    storyId,
    csfFile,
  }: {
    storyId: StoryId;
    csfFile: CSFFile<TFramework>;
  }): Story<TFramework> {
    const storyAnnotations = csfFile.stories[storyId];
    if (!storyAnnotations) {
      throw new Error(`Didn't find '${storyId}' in CSF file, this is unexpected`);
    }
    const componentAnnotations = csfFile.meta;

    const story = this.prepareStoryWithCache(
      storyAnnotations,
      componentAnnotations,
      this.projectAnnotations
    );
    this.args.setInitial(story);
    this.hooks[story.id] = this.hooks[story.id] || new HooksContext();
    return story;
  }

  // If we have a CSF file we can get all the stories from it synchronously
  componentStoriesFromCSFFile({ csfFile }: { csfFile: CSFFile<TFramework> }): Story<TFramework>[] {
    return Object.keys(csfFile.stories).map((storyId: StoryId) =>
      this.storyFromCSFFile({ storyId, csfFile })
    );
  }

  // A prepared story does not include args, globals or hooks. These are stored in the story store
  // and updated separtely to the (immutable) story.
  getStoryContext(story: Story<TFramework>): Omit<StoryContextForLoaders<TFramework>, 'viewMode'> {
    return {
      ...story,
      args: this.args.get(story.id),
      globals: this.globals.get(),
      hooks: this.hooks[story.id] as unknown,
    };
  }

  cleanupStory(story: Story<TFramework>): void {
    this.hooks[story.id].clean();
  }

  extract(
    options: ExtractOptions = { includeDocsOnly: false }
  ): Record<StoryId, StoryContextForEnhancers<TFramework>> {
    if (!this.cachedCSFFiles) {
      throw new Error('Cannot call extract() unless you call cacheAllCSFFiles() first.');
    }

    return Object.entries(this.storyIndex.stories).reduce((acc, [storyId, { importPath }]) => {
      const csfFile = this.cachedCSFFiles[importPath];
      const story = this.storyFromCSFFile({ storyId, csfFile });

      if (!options.includeDocsOnly && story.parameters.docsOnly) {
        return acc;
      }

      acc[storyId] = Object.entries(story).reduce(
        (storyAcc, [key, value]) => {
          if (typeof value === 'function') {
            return storyAcc;
          }
          if (Array.isArray(value)) {
            return Object.assign(storyAcc, { [key]: value.slice().sort() });
          }
          return Object.assign(storyAcc, { [key]: value });
        },
        { args: story.initialArgs }
      );
      return acc;
    }, {} as Record<string, any>);
  }

  getSetStoriesPayload() {
    const stories = this.extract({ includeDocsOnly: true });

    const kindParameters: Parameters = Object.values(stories).reduce(
      (acc: Parameters, { title }: { title: ComponentTitle }) => {
        acc[title] = {};
        return acc;
      },
      {} as Parameters
    );

    return {
      v: 2,
      globals: this.globals.get(),
      globalParameters: {},
      kindParameters,
      stories,
    };
  }

  getStoriesJsonData = () => {
    const value = this.getSetStoriesPayload();
    const allowedParameters = ['fileName', 'docsOnly', 'framework', '__id', '__isArgsStory'];

    const stories: Record<StoryId, StoryIndexEntry | V2CompatIndexEntry> = mapValues(
      value.stories,
      (story) => ({
        ...pick(story, ['id', 'name', 'title']),
        importPath: this.storyIndex.stories[story.id].importPath,
        ...(!global.FEATURES?.breakingChangesV7 && {
          kind: story.title,
          story: story.name,
          parameters: {
            ...pick(story.parameters, allowedParameters),
            fileName: this.storyIndex.stories[story.id].importPath,
          },
        }),
      })
    );

    return {
      v: 3,
      stories,
    };
  };

  raw(): BoundStory<TFramework>[] {
    return Object.values(this.extract()).map(({ id }: { id: StoryId }) => this.fromId(id));
  }

  fromId(storyId: StoryId): BoundStory<TFramework> {
    if (!this.cachedCSFFiles) {
      throw new Error('Cannot call fromId/raw() unless you call cacheAllCSFFiles() first.');
    }

    let importPath;
    try {
      ({ importPath } = this.storyIndex.storyIdToEntry(storyId));
    } catch (err) {
      return null;
    }
    const csfFile = this.cachedCSFFiles[importPath];
    const story = this.storyFromCSFFile({ storyId, csfFile });
    return {
      ...story,
      storyFn: (update) => {
        const context = {
          ...this.getStoryContext(story),
          viewMode: 'story',
        } as StoryContext<TFramework>;

        return story.unboundStoryFn({ ...context, ...update });
      },
    };
  }
}
