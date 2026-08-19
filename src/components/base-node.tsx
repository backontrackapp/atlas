import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

export function BaseNode({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'relative rounded-md border border-zinc-700 bg-zinc-900 text-zinc-100 shadow-sm',
        'hover:ring-1 hover:ring-zinc-500',
        'in-[.selected]:border-zinc-400 in-[.selected]:shadow-lg',
        className,
      )}
      tabIndex={0}
      {...props}
    />
  )
}

export function BaseNodeHeader({ className, ...props }: ComponentProps<'header'>) {
  return (
    <header
      {...props}
      className={cn(
        'mx-0 my-0 -mb-1 flex flex-row items-center justify-between gap-2 border-b border-zinc-700 px-3 py-2',
        className,
      )}
    />
  )
}

export function BaseNodeHeaderTitle({ className, ...props }: ComponentProps<'h3'>) {
  return (
    <h3
      data-slot="base-node-title"
      className={cn('flex-1 select-none text-sm font-semibold', className)}
      {...props}
    />
  )
}

export function BaseNodeContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="base-node-content"
      className={cn('flex flex-col gap-y-2 p-3', className)}
      {...props}
    />
  )
}

export function BaseNodeFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="base-node-footer"
      className={cn('flex flex-col items-center gap-y-2 border-t border-zinc-700 px-3 pb-3 pt-2', className)}
      {...props}
    />
  )
}
