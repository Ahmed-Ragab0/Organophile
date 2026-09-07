const crypto = require('crypto');
const queryString = require('query-string');
const _ = require('underscore');

// Exactly Kashier's documented Node.js algorithm.
function kashier(data, apiKey) {
  const keys = [...data.signatureKeys].sort();
  const objectSignaturePayload = _.pick(data, keys);
  const signaturePayload = queryString.stringify(objectSignaturePayload);
  const signature = crypto.createHmac('sha256', apiKey).update(signaturePayload).digest('hex');
  return { signaturePayload, signature };
}

const KEY = 'test-payment-api-key-0123456789';

const cases = [
  {
    name: 'canonical-pay-success',
    data: {
      amount: 100,
      currency: 'EGP',
      kashierOrderId: '8a2c0f11-aaaa-bbbb',
      merchantOrderId: 'ORDER-0001',
      status: 'SUCCESS',
      transactionId: 'TRX-0001',
      extraIgnored: 'should-not-appear',
      signatureKeys: [
        'amount',
        'currency',
        'kashierOrderId',
        'merchantOrderId',
        'status',
        'transactionId',
      ],
    },
  },
  {
    name: 'unsorted-signature-keys',
    data: {
      transactionId: 'TRX-9',
      status: 'FAILURE',
      merchantOrderId: 'YOK-00123',
      kashierOrderId: 'k-9',
      currency: 'EGP',
      amount: 250.75,
      signatureKeys: [
        'transactionId',
        'amount',
        'status',
        'currency',
        'merchantOrderId',
        'kashierOrderId',
      ],
    },
  },
  {
    name: 'float-and-int-amounts',
    data: {
      amount: 0.5,
      currency: 'EGP',
      status: 'SUCCESS',
      signatureKeys: ['amount', 'currency', 'status'],
    },
  },
  {
    name: 'integer-like-float',
    data: {
      amount: 100.0,
      currency: 'EGP',
      status: 'SUCCESS',
      signatureKeys: ['amount', 'currency', 'status'],
    },
  },
  {
    name: 'arabic-values',
    data: {
      apikeyname: 'يوكيرا',
      status: 'SUCCESS',
      merchantOrderId: 'طلب-١٢٣',
      signatureKeys: ['apikeyname', 'status', 'merchantOrderId'],
    },
  },
  {
    name: 'spaces-and-plus',
    data: {
      a: 'hello world',
      b: 'a+b',
      c: 'x&y=z',
      signatureKeys: ['a', 'b', 'c'],
    },
  },
  {
    name: 'rfc3986-strict-chars',
    data: {
      a: "it's!",
      b: '(paren)',
      c: 'star*here',
      d: 'tilde~ok',
      e: 'dot.dash-_',
      signatureKeys: ['a', 'b', 'c', 'd', 'e'],
    },
  },
  {
    name: 'slash-question-hash',
    data: {
      url: 'https://shop.example.com/return?x=1#frag',
      status: 'SUCCESS',
      signatureKeys: ['url', 'status'],
    },
  },
  {
    name: 'empty-string-value',
    data: {
      a: '',
      b: 'ok',
      signatureKeys: ['a', 'b'],
    },
  },
  {
    name: 'null-value',
    data: {
      a: null,
      b: 'ok',
      signatureKeys: ['a', 'b'],
    },
  },
  {
    name: 'boolean-values',
    data: {
      isTestWebhook: true,
      flag: false,
      signatureKeys: ['isTestWebhook', 'flag'],
    },
  },
  {
    name: 'missing-key-in-data',
    data: {
      a: 'present',
      signatureKeys: ['a', 'totallyMissing'],
    },
  },
  {
    name: 'single-key',
    data: {
      transactionId: 'TRX-solo',
      signatureKeys: ['transactionId'],
    },
  },
  {
    name: 'uppercase-lowercase-sort',
    data: {
      Zebra: '1',
      apple: '2',
      Banana: '3',
      signatureKeys: ['Zebra', 'apple', 'Banana'],
    },
  },
  {
    name: 'numeric-string-vs-number',
    data: {
      a: '007',
      b: 7,
      signatureKeys: ['a', 'b'],
    },
  },
];

const out = cases.map((c) => {
  const r = kashier(c.data, KEY);
  return {
    name: c.name,
    apiKey: KEY,
    data: c.data,
    signaturePayload: r.signaturePayload,
    signature: r.signature,
  };
});

console.log(
  JSON.stringify(
    {
      generatedWith: {
        'query-string': require('query-string/package.json').version,
        underscore: require('underscore/package.json').version,
      },
      vectors: out,
    },
    null,
    2,
  ),
);
