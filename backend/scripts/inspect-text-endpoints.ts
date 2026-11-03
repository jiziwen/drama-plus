import { db, schema } from '../src/db/index.js'
const configs = await db.select().from(schema.aiServiceConfigs)
console.log(JSON.stringify(configs.filter(c=>c.serviceType==='text').map(c=>({id:c.id,provider:c.provider,baseUrl:c.baseUrl,model:c.model}))))
