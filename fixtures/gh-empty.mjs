#!/usr/bin/env node
// gh のふりをする。PR が 1 つもない。

import { answer } from './samples.ts'

process.stdin.resume()
process.stdin.on('end', () => console.log(answer([])))
