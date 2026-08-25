import { expect } from 'vitest'
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'

// Why: renderer tests use the shared Vitest config with a per-file happy-dom
// environment. Register the DOM assertions once for every worker so matcher
// availability does not depend on import order or another file's mock cleanup.
expect.extend(jestDomMatchers)
