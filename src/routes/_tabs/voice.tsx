import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_tabs/voice')({
  component: RouteComponent,
})

function RouteComponent() {
  return <div>Hello "/(tabs)/voice"!</div>
}
