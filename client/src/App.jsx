import { useState } from 'react'

import { Button } from './components/pill-shaped-button'

function App() {
  const [count, setCount] = useState(0)

  return (
    <div className=" flex justify-center items-center min-h-screen">
      <Button className=' max-w-lg' variant="secondary" onClick={() => { }}>
        <img src="/google.svg" alt="Google" className="w-5 h-5" />
        Continue with Google
      </Button>
    </div>
  )
}

export default App
