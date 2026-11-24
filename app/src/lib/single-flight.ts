import { useState } from 'react'
import { useMutation, useQueryClient, type DefaultError, type UseMutationOptions, type UseMutationResult } from '@tanstack/react-query'
import { aborted, currentScope, isCurrentScope, selectedWorkspace, type RequestScope } from '../data/live'
import { flightKey, once } from './flight'

/** A write dropped because the same write is still in flight. It rejects once that write settles, and is never shown. */
export class DuplicateSubmission extends Error {
  constructor() { super('This is already being sent.'); this.name = 'DuplicateSubmission' }
}
export const isDuplicateSubmission = (error: unknown): error is DuplicateSubmission => error instanceof DuplicateSubmission

/** What a guarded write is: the operation (by default its function's source, which is the same in every render and
 *  remount, and differs between call sites unless they make the same call) and the target its function closes over
 *  rather than takes as input, such as the open conversation. A write whose target is in its input needs no target. */
export type Flight = { target?: unknown; operation?: string; requestScope?: RequestScope | null }

/**
 * useMutation that sends a write once while it is in flight. A double click, Enter then a click, or a click after the
 * re-render that follows the first (an icon button that stays enabled) reaches the handler again before the write
 * answers. A call with the same operation, target and input as one in flight isn't sent: its promise rejects with
 * DuplicateSubmission once the first settles, so the code after it (close the dialog, open what was created) runs
 * once. The same operation on another target or with another input is sent (Star on conversation B while Star on A is
 * pending). Once the first call settles, the same write can be sent again.
 */
const activeScope = (scope: RequestScope | null) => scope && (scope.account !== null || scope.workspace !== null) ? scope : null

export function useGuardedMutation<TData = unknown, TError = DefaultError, TVariables = void, TContext = unknown>({ target, operation, requestScope: explicitScope, ...options }: UseMutationOptions<TData, TError, TVariables, TContext> & Flight): UseMutationResult<TData, TError, TVariables, TContext> {
  const client = useQueryClient()
  const [mountedScope] = useState(currentScope)
  const scope = explicitScope === undefined ? activeScope(mountedScope) : activeScope(explicitScope)
  const mutation = useMutation(options)
  const name = operation ?? options.mutationFn?.toString()
  const mutateAsync = ((...args: Parameters<typeof mutation.mutateAsync>) => {
    if (scope && !isCurrentScope(scope)) return Promise.reject(aborted())
    const { call, duplicate } = once(client, name === undefined ? undefined : flightKey(selectedWorkspace(), name, target, args[0]), () => mutation.mutateAsync(...args))
    return duplicate ? new Promise<TData>((_, reject) => { const drop = () => reject(new DuplicateSubmission()); call.then(drop, drop) }) : call
  }) as typeof mutation.mutateAsync
  const mutate = ((...args: Parameters<typeof mutation.mutate>) => { mutateAsync(...args).catch(() => {}) }) as typeof mutation.mutate
  return { ...mutation, mutate, mutateAsync }
}

/**
 * The same guard for a write sent with request() or the API from a handler (the rule editor's saves, New endpoint, an
 * inbox key, template Publish): a call with the same operation, target and arguments as one in flight isn't run again;
 * it gets that run's promise, so the write and what it shows happen once and the caller still gets the result. Other
 * arguments or another target still run.
 */
export function useSingleFlight<A extends unknown[], R>(operation: string, run: (...args: A) => Promise<R>, target?: unknown) {
  const client = useQueryClient()
  const [mountedScope] = useState(currentScope)
  const scope = activeScope(mountedScope)
  return (...args: A): Promise<R> => {
    if (scope && !isCurrentScope(scope)) return Promise.reject(aborted())
    return once(client, flightKey(selectedWorkspace(), operation, target, args), () => run(...args)).call
  }
}
