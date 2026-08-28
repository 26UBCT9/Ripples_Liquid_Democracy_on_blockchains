/**
 * Minimal EIP-712 signing for exactly one struct: the OpenZeppelin
 * ERC2771Forwarder ForwardRequest. Used by the local demo accounts; MetaMask
 * accounts sign the same typed data via eth_signTypedData_v4 instead.
 *
 * web3.js v4 has no local typed-data signer, so the digest is assembled by
 * hand (it is short and fixed) and signed with the noble secp256k1 that web3
 * itself uses underneath.
 */
import { secp256k1 } from "ethereum-cryptography/secp256k1.js";
import { web3 } from "./chain";

const DOMAIN_TYPEHASH = () =>
  web3.utils.keccak256(
    web3.utils.utf8ToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
  );

const FORWARD_REQUEST_TYPEHASH = () =>
  web3.utils.keccak256(
    web3.utils.utf8ToHex(
      "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data)"
    )
  );

export function forwardRequestDigest({ name, version, chainId, verifyingContract }, request) {
  const abi = web3.eth.abi;
  const domainSeparator = web3.utils.keccak256(
    abi.encodeParameters(
      ["bytes32", "bytes32", "bytes32", "uint256", "address"],
      [
        DOMAIN_TYPEHASH(),
        web3.utils.keccak256(web3.utils.utf8ToHex(name)),
        web3.utils.keccak256(web3.utils.utf8ToHex(version)),
        chainId,
        verifyingContract,
      ]
    )
  );
  const structHash = web3.utils.keccak256(
    abi.encodeParameters(
      ["bytes32", "address", "address", "uint256", "uint256", "uint256", "uint48", "bytes32"],
      [
        FORWARD_REQUEST_TYPEHASH(),
        request.from,
        request.to,
        request.value,
        request.gas,
        request.nonce,
        request.deadline,
        web3.utils.keccak256(request.data),
      ]
    )
  );
  return web3.utils.keccak256("0x1901" + domainSeparator.slice(2) + structHash.slice(2));
}

/** Sign a 32-byte digest with a raw private key; returns a 65-byte r||s||v signature. */
export function signDigest(digest, privateKey) {
  const sig = secp256k1.sign(digest.slice(2), privateKey.slice(2));
  const v = (sig.recovery + 27).toString(16).padStart(2, "0");
  return "0x" + sig.toCompactHex() + v;
}
