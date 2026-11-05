import {defineConfig} from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'pbf/index': 'src/pbf/index.ts',
    'mvt/index': 'src/mvt/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  outExtension: ({format}) => ({js: format === 'cjs' ? '.cjs' : '.js'}),
});
