import { defineFixture } from '../../component-fixtures/component-fixture'
import { ContextIntegrityNotice } from './ContextIntegrityNotice'

export const blocked = defineFixture({
  width: 360,
  render: () => (
    <ContextIntegrityNotice
      summary={{
        version: 1,
        verification: 'available',
        unverifiedCount: 3,
        overflowCount: 0,
        durability: 'saved'
      }}
      unavailable={false}
    />
  )
})

export const pending = defineFixture({
  width: 280,
  render: () => (
    <ContextIntegrityNotice
      summary={{
        version: 1,
        verification: 'available',
        unverifiedCount: 2,
        overflowCount: 0,
        durability: 'pending'
      }}
      unavailable={false}
    />
  )
})

export const hostUnavailable = defineFixture({
  width: 360,
  render: () => <ContextIntegrityNotice summary={null} unavailable />
})

export const storageUnavailable = defineFixture({
  width: 360,
  render: () => (
    <ContextIntegrityNotice
      summary={{
        version: 1,
        verification: 'available',
        unverifiedCount: 0,
        overflowCount: 0,
        durability: 'unavailable'
      }}
      unavailable={false}
    />
  )
})
