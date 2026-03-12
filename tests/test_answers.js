async function test() {
  const BASE_URL = 'http://localhost:5000/api/answers'; // Adjust port if needed
  
  try {
    console.log('1. Testing POST /api/answers');
    let res = await fetch(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_id: '64d2a1f8e1b3c9a42f568a12',
        question_id: '64d2b2f8e1b3c9a42f568a34',
        answer: 'Test created from script'
      })
    });
    
    if (!res.ok) {
       console.log('Server not on 5000 or error:', await res.text());
       return;
    }
    
    const createdData = await res.json();
    console.log('Created:', createdData);
    const id = createdData.data._id;
    
    console.log('\n2. Testing GET /api/answers/:id');
    res = await fetch(`${BASE_URL}/${id}`);
    console.log('Get By ID:', await res.json());
    
    console.log('\n3. Testing PUT /api/answers/:id');
    res = await fetch(`${BASE_URL}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: 'Updated answer' })
    });
    console.log('Update:', await res.json());
    
    console.log('\n4. Testing GET /api/answers/business/:business_id');
    res = await fetch(`${BASE_URL}/business/64d2a1f8e1b3c9a42f568a12`);
    console.log('Get By Business ID:', await res.json());
    
  } catch (err) {
    console.error('Fetch error:', err.message);
  }
}

test();
