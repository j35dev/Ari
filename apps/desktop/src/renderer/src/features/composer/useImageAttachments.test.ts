import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MAX_IMAGES, MAX_IMAGE_BYTES, useImageAttachments } from './useImageAttachments'

function imageFile(name = 'a.png', size = 8): File {
  return new File([new Uint8Array(size)], name, { type: 'image/png' })
}

function otherFile(name = 'notes.txt'): File {
  return new File(['hello'], name, { type: 'text/plain' })
}

/** Minimal FileList stand-in: array-like plus `item()`, as paste/drop produce. */
function fakeFileList(files: File[]): FileList {
  return Object.assign([...files], {
    item: (index: number) => files[index] ?? null,
  })
}

describe('useImageAttachments', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useImageAttachments())
    expect(result.current.images).toEqual([])
  })

  it('keeps only image files', () => {
    const { result } = renderHook(() => useImageAttachments())
    const png = imageFile('a.png')
    act(() =>
      result.current.addFiles([
        otherFile('notes.txt'),
        png,
        new File([new Uint8Array(2)], 'b.bin', { type: 'application/octet-stream' }),
      ]),
    )
    expect(result.current.images).toEqual([png])
  })

  it('accepts a FileList-shaped input', () => {
    const { result } = renderHook(() => useImageAttachments())
    const png = imageFile()
    act(() => result.current.addFiles(fakeFileList([otherFile(), png])))
    expect(result.current.images).toEqual([png])
  })

  it('caps the total at 4 images', () => {
    const { result } = renderHook(() => useImageAttachments())
    act(() => result.current.addFiles(Array.from({ length: 5 }, (_, i) => imageFile(`${i}.png`))))
    expect(result.current.images).toHaveLength(MAX_IMAGES)
    expect(result.current.images.map((file) => file.name)).toEqual([
      '0.png',
      '1.png',
      '2.png',
      '3.png',
    ])
  })

  it('fills only the remaining slots when partially full', () => {
    const { result } = renderHook(() => useImageAttachments())
    act(() => result.current.addFiles([imageFile('a.png'), imageFile('b.png'), imageFile('c.png')]))
    act(() => result.current.addFiles([imageFile('d.png'), imageFile('e.png')]))
    expect(result.current.images.map((file) => file.name)).toEqual([
      'a.png',
      'b.png',
      'c.png',
      'd.png',
    ])
  })

  it('ignores additions once full', () => {
    const { result } = renderHook(() => useImageAttachments())
    const four = Array.from({ length: MAX_IMAGES }, (_, i) => imageFile(`${i}.png`))
    act(() => result.current.addFiles(four))
    act(() => result.current.addFiles([imageFile('late.png')]))
    expect(result.current.images).toEqual(four)
  })

  it('rejects an image larger than 8MB', () => {
    const { result } = renderHook(() => useImageAttachments())
    act(() => result.current.addFiles([imageFile('big.png', MAX_IMAGE_BYTES + 1)]))
    expect(result.current.images).toEqual([])
  })

  it('accepts an image of exactly 8MB', () => {
    const { result } = renderHook(() => useImageAttachments())
    const atCap = imageFile('cap.png', MAX_IMAGE_BYTES)
    act(() => result.current.addFiles([atCap]))
    expect(result.current.images).toEqual([atCap])
  })

  it('removes the image at the given index', () => {
    const { result } = renderHook(() => useImageAttachments())
    const a = imageFile('a.png')
    const b = imageFile('b.png')
    act(() => result.current.addFiles([a, b]))
    act(() => result.current.removeAt(0))
    expect(result.current.images).toEqual([b])
  })

  it('ignores out-of-range removal indices', () => {
    const { result } = renderHook(() => useImageAttachments())
    const a = imageFile()
    act(() => result.current.addFiles([a]))
    act(() => result.current.removeAt(5))
    expect(result.current.images).toEqual([a])
  })

  it('clears all images', () => {
    const { result } = renderHook(() => useImageAttachments())
    act(() => result.current.addFiles([imageFile(), imageFile('b.png')]))
    act(() => result.current.clear())
    expect(result.current.images).toEqual([])
  })
})
