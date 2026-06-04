import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_tabs/video')({
  component: RouteComponent,
})

function RouteComponent() {
  return <div>Hello "/(tabs)/video"!</div>
}
